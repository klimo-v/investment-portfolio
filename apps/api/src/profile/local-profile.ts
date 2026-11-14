import Database from 'better-sqlite3';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { constants, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PortfolioBackup } from '../db/portfolio-backup';
import { applyMigrations } from '../db/apply-migrations';
import { validateRuntime } from './runtime-check';
import {
  absolutePath,
  atomicJson,
  hashFile,
  privateDirectory,
  ProfileError,
  syncDirectory,
  syncFile,
} from './profile-files';

const Pending = z.object({
  stage: z.string(),
  digest: z.string(),
  previousDigest: z.string().nullable(),
  requiredRelease: z.object({ id: z.string(), launchPath: z.string() }).nullable(),
});
const Pair = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  databaseSha256: z.string(),
  applicationId: z.string(),
  applicationDigest: z.string().optional(),
});
interface Options {
  dataDir: string;
  dbPath: string;
  migrationsFolder: string;
  resources?: string;
}

/** Все вызовы выполняются под lockProfile и до импорта client.ts. */
export class LocalProfile {
  readonly backups: PortfolioBackup;
  private readonly state: string;
  constructor(readonly options: Options) {
    this.backups = new PortfolioBackup(options.migrationsFolder);
    this.state = join(options.dataDir, '.profile', createHash('sha256').update(options.dbPath).digest('hex').slice(0, 16));
  }
  private initialiseDirectories(): void {
    privateDirectory(this.options.dataDir);
    privateDirectory(this.state);
  }
  private get pendingPath(): string {
    return join(this.state, 'pending.json');
  }
  private get recoveryPath(): string {
    return join(this.state, 'required-release.json');
  }
  private stage(): string {
    this.initialiseDirectories();
    mkdirSync(dirname(this.options.dbPath), { recursive: true, mode: 0o700 });
    return join(
      mkdtempSync(
        join(dirname(this.options.dbPath), `.portfolio-${basename(this.options.dbPath)}-stage-`),
      ),
      'portfolio.sqlite',
    );
  }
  private removeStage(file: string): void {
    rmSync(dirname(file), { recursive: true, force: true });
  }
  private assertStage(file: string): void {
    if (
      dirname(dirname(file)) !== dirname(this.options.dbPath) ||
      !dirname(file)
        .split('/')
        .pop()
        ?.startsWith(`.portfolio-${basename(this.options.dbPath)}-stage-`) ||
      file.split('/').pop() !== 'portfolio.sqlite'
    ) {
      throw new ProfileError(
        'RECOVERY_CONFLICT',
        'Некорректное состояние незавершённой установки. Рабочая база сохранена.',
      );
    }
  }
  /** Незавершённая установка не зависит от исходника: подготовленный файл уже локальный. */
  resume(): void {
    this.initialiseDirectories();
    if (existsSync(this.pendingPath)) {
      const pending = Pending.parse(JSON.parse(readFileSync(this.pendingPath, 'utf8')));
      this.assertStage(pending.stage);
      const current = existsSync(this.options.dbPath) ? hashFile(this.options.dbPath) : null;
      if (current !== pending.digest) {
        if (
          current !== pending.previousDigest ||
          !existsSync(pending.stage) ||
          hashFile(pending.stage) !== pending.digest ||
          existsSync(`${this.options.dbPath}-wal`) ||
          existsSync(`${this.options.dbPath}-shm`)
        ) {
          throw new ProfileError(
            'RECOVERY_CONFLICT',
            'Файлы изменились после прерывания. Автоматическая замена остановлена; данные сохранены.',
          );
        }
        if (pending.previousDigest === null) linkSync(pending.stage, this.options.dbPath);
        else renameSync(pending.stage, this.options.dbPath);
        syncDirectory(dirname(this.options.dbPath));
      }
      if (pending.requiredRelease) atomicJson(this.recoveryPath, pending.requiredRelease);
      else if (existsSync(this.recoveryPath)) unlinkSync(this.recoveryPath);
      this.removeStage(pending.stage);
      unlinkSync(this.pendingPath);
      syncDirectory(this.state);
    }
    // Каталоги создаются только под эксклюзивной блокировкой, активных чужих stage здесь нет.
    if (existsSync(dirname(this.options.dbPath)))
      for (const name of readdirSync(dirname(this.options.dbPath))) {
        if (name.startsWith(`.portfolio-${basename(this.options.dbPath)}-stage-`))
          rmSync(join(dirname(this.options.dbPath), name), { recursive: true, force: true });
      }
  }
  private publish(
    file: string,
    previousDigest: string | null,
    requiredRelease: z.infer<typeof Pending>['requiredRelease'] = null,
  ): void {
    syncFile(file);
    atomicJson(this.pendingPath, {
      stage: file,
      digest: hashFile(file),
      previousDigest,
      requiredRelease,
    });
    this.resume();
  }
  private ensureAbsent(): void {
    if (existsSync(this.options.dbPath) || existsSync(`${this.options.dbPath}-wal`)) {
      throw new ProfileError(
        'PROFILE_EXISTS',
        'Рабочий профиль уже существует. Для замены используйте раздел «Данные» в приложении.',
      );
    }
  }
  private async capture(source: string, destination: string): Promise<void> {
    let connection: Database.Database | undefined;
    try {
      absolutePath(source);
      if (!statSync(source).isFile()) throw new Error();
      connection = new Database(source, { readonly: true, fileMustExist: true });
      await this.backups.backup(connection, destination);
    } catch {
      throw new ProfileError(
        'SOURCE_UNREADABLE',
        'Не удалось прочитать базу. Проверьте путь и дождитесь полной загрузки файла из облака, затем выберите его повторно.',
      );
    } finally {
      connection?.close();
    }
  }
  async inspect(source: string) {
    const temporary = this.backups.temporary();
    try {
      await this.capture(source, temporary.file);
      return this.backups.prepare(temporary.file);
    } finally {
      temporary.dispose();
    }
  }
  async initialise(source?: string) {
    this.ensureAbsent();
    const stage = this.stage();
    try {
      if (source) await this.capture(source, stage);
      else {
        const empty = new Database(stage);
        try {
          applyMigrations(empty, this.options.migrationsFolder);
        } finally {
          empty.close();
        }
      }
      chmodSync(stage, 0o600);
      const summary = this.backups.prepare(stage);
      this.publish(stage, null);
      return { ...summary, databasePath: this.options.dbPath };
    } finally {
      if (!existsSync(this.pendingPath)) this.removeStage(stage);
    }
  }
  async export(destination: string): Promise<void> {
    absolutePath(destination);
    if (existsSync(destination))
      throw new ProfileError(
        'DESTINATION_EXISTS',
        'Файл уже существует. Выберите новое имя для копии.',
      );
    const temporary = this.backups.temporary();
    try {
      await this.capture(this.options.dbPath, temporary.file);
      this.backups.inspect(temporary.file);
      copyFileSync(temporary.file, destination, constants.COPYFILE_EXCL);
      syncFile(destination);
      syncDirectory(dirname(destination));
    } finally {
      temporary.dispose();
    }
  }
  status() {
    return {
      exists: existsSync(this.options.dbPath),
      databasePath: this.options.dbPath,
      recovery: existsSync(this.recoveryPath)
        ? (JSON.parse(readFileSync(this.recoveryPath, 'utf8')) as unknown)
        : null,
    };
  }
  /** Выбор сервера после отката: проверяем текущую БД, снимок не публикуем. */
  async resolveStart(): Promise<{ launchPath: string | null }> {
    if (!existsSync(this.recoveryPath)) return { launchPath: null };
    try {
      const required = z
        .object({ id: z.string(), launchPath: z.string() })
        .parse(JSON.parse(readFileSync(this.recoveryPath, 'utf8')));
      const application = realpathSync(dirname(absolutePath(required.launchPath)));
      const backups = realpathSync(join(this.options.dataDir, 'backups'));
      if (!application.startsWith(backups + '/') || basename(required.launchPath) !== 'start.sh')
        throw new Error();
      const pair = Pair.parse(
        JSON.parse(readFileSync(join(application, '../recovery.json'), 'utf8')),
      );
      if (
        pair.applicationId !== required.id ||
        this.releaseId(application) !== required.id ||
        (pair.applicationDigest && this.runtimeDigest(application) !== pair.applicationDigest)
      )
        throw new Error();
      const version = new PortfolioBackup(join(application, 'server/migrations')).inspect(
        this.options.dbPath,
      );
      if (version.appliedMigrations !== version.availableMigrations) throw new Error();
      const copy = this.backups.temporary();
      try {
        await this.capture(this.options.dbPath, copy.file);
        await validateRuntime(application, copy.file);
      } finally {
        copy.dispose();
      }
      return { launchPath: join(application, 'start.sh') };
    } catch {
      throw new ProfileError(
        'RECOVERY_APPLICATION_REQUIRED',
        'Сохранённый сервер недоступен, повреждён или несовместим с текущей базой. Данные не восстановлены повторно и сохранены без изменений.',
      );
    }
  }
  private releaseId(resources: string): string {
    // Идентификатор остаётся понятен прежним версиям при проверке required-release.
    return createHash('sha256')
      .update(
        [
          'server/main.js',
          'server/migrations/meta/_journal.json',
          'web/index.html',
          'launch.mjs',
          'build-manifest.json',
        ]
          .map((file) => hashFile(join(resources, file)))
          .join(''),
      )
      .digest('hex');
  }
  private runtimeDigest(resources: string): string {
    const root = realpathSync(resources);
    const hash = createHash('sha256');
    const visit = (directory: string): void => {
      for (const name of readdirSync(join(root, directory)).sort()) {
        const path = join(directory, name);
        const file = join(root, path);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
          if (!realpathSync(file).startsWith(root + '/')) throw new Error('External runtime link');
          hash.update(JSON.stringify([path, 'link', readlinkSync(file)]));
        } else if (stat.isDirectory()) visit(path);
        else if (stat.isFile())
          hash.update(JSON.stringify([path, stat.mode & 0o111, hashFile(file)]));
        else throw new Error('Unsupported runtime file');
      }
    };
    visit('');
    return hash.digest('hex');
  }
  /** Сохраняем ресурсы предыдущего успешно запущенного приложения до будущей замены .app. */
  rememberRelease(resources = this.options.resources): void {
    if (!resources) return;
    if (resolve(this.options.dataDir).startsWith(resolve(resources) + '/')) {
      throw new ProfileError(
        'INVALID_PROFILE_LOCATION',
        'Каталог данных должен находиться вне ресурсов приложения.',
      );
    }
    const id = this.releaseId(resources);
    const releases = join(this.state, 'releases');
    privateDirectory(releases);
    for (const name of readdirSync(releases))
      if (name.startsWith('copy-')) rmSync(join(releases, name), { recursive: true, force: true });
    const destination = join(releases, id);
    if (!existsSync(destination)) {
      const staging = join(releases, `copy-${randomUUID()}`);
      try {
        cpSync(resources, staging, { recursive: true, verbatimSymlinks: true });
        renameSync(staging, destination);
        syncDirectory(releases);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (this.runtimeDigest(destination) !== this.runtimeDigest(resources))
      throw new ProfileError('APPLICATION_DAMAGED', 'Сохранённые ресурсы приложения повреждены.');
    atomicJson(join(this.state, 'current-release.json'), {
      id,
      digest: this.runtimeDigest(destination),
    });
  }
  private previousRelease(): string {
    try {
      const record = z
        .object({ id: z.string().regex(/^[a-f0-9-]+$/), digest: z.string().optional() })
        .parse(JSON.parse(readFileSync(join(this.state, 'current-release.json'), 'utf8')));
      const path = join(this.state, 'releases', record.id);
      if (
        this.releaseId(path) === record.id &&
        (!record.digest || this.runtimeDigest(path) === record.digest)
      )
        return path;
    } catch {
      /* Ни один путь из повреждённого указателя не используется. */
    }
    throw new ProfileError(
      'UPDATE_PREPARATION_REQUIRED',
      'Нет сохранённой прежней версии приложения. Подготовьте обновление командой prepare-update из прежней версии. Рабочая база не изменена.',
    );
  }
  private async pair(application: string): Promise<string> {
    const parent = join(this.options.dataDir, 'backups');
    privateDirectory(parent);
    const staging = mkdtempSync(join(parent, '.preparing-'));
    const final = join(
      parent,
      `update-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    );
    try {
      const file = join(staging, 'portfolio.sqlite');
      await this.capture(this.options.dbPath, file);
      const compatibility = new PortfolioBackup(join(application, 'server/migrations')).inspect(
        file,
      );
      if (compatibility.appliedMigrations !== compatibility.availableMigrations)
        throw new ProfileError(
          'APPLICATION_MISMATCH',
          'Предыдущая версия приложения не соответствует схеме базы.',
        );
      cpSync(application, join(staging, 'application'), {
        recursive: true,
        verbatimSymlinks: true,
      });
      const manifest: z.infer<typeof Pair> = {
        version: 1,
        createdAt: new Date().toISOString(),
        databaseSha256: hashFile(file),
        applicationId: this.releaseId(application),
        applicationDigest: this.runtimeDigest(application),
      };
      atomicJson(join(staging, 'recovery.json'), manifest);
      syncFile(file);
      renameSync(staging, final);
      syncDirectory(parent);
      return final;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  async prepareUpdate(previousApplication?: string): Promise<string> {
    const application = previousApplication
      ? absolutePath(previousApplication)
      : this.options.resources;
    if (!application)
      throw new ProfileError(
        'INSTALLED_REQUIRED',
        'Подготовка пары требует автономный runtime приложения.',
      );
    const version = new PortfolioBackup(join(application, 'server/migrations')).inspect(
      this.options.dbPath,
    );
    if (version.appliedMigrations !== version.availableMigrations) {
      throw new ProfileError(
        'APPLICATION_MISMATCH',
        'Создайте пару из версии приложения, которая соответствует текущей схеме базы.',
      );
    }
    this.rememberRelease(application);
    const result = await this.pair(application);
    if (existsSync(this.recoveryPath)) {
      const required = z
        .object({ id: z.string() })
        .parse(JSON.parse(readFileSync(this.recoveryPath, 'utf8')));
      if (required.id === this.releaseId(application)) {
        unlinkSync(this.recoveryPath);
        syncDirectory(this.state);
      }
    }
    return result;
  }
  private checkpoint(): string {
    const connection = new Database(this.options.dbPath, { fileMustExist: true, timeout: 0 });
    try {
      const result = connection.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (result.some((row) => row.busy)) throw new Error();
    } catch {
      throw new ProfileError(
        'PROFILE_BUSY',
        'База открыта другим процессом. Закройте его и повторите.',
      );
    } finally {
      connection.close();
    }
    if (existsSync(`${this.options.dbPath}-wal`) || existsSync(`${this.options.dbPath}-shm`)) {
      throw new ProfileError(
        'PROFILE_BUSY',
        'База открыта другим процессом. Закройте его и повторите.',
      );
    }
    return hashFile(this.options.dbPath);
  }
  async beforeHttp(): Promise<void> {
    if (!existsSync(this.options.dbPath))
      throw new ProfileError(
        'ONBOARDING_REQUIRED',
        'Выберите «Начать с пустого» или восстановите файл резервной копии.',
      );
    if (existsSync(this.recoveryPath)) {
      const required = z
        .object({ id: z.string(), launchPath: z.string() })
        .parse(JSON.parse(readFileSync(this.recoveryPath, 'utf8')));
      if (!this.options.resources || this.releaseId(this.options.resources) !== required.id) {
        throw new ProfileError(
          'RECOVERY_APPLICATION_REQUIRED',
          `База восстановлена для прежней версии. Запустите приложение из сохранённой пары: ${required.launchPath}`,
        );
      }
    }
    const version = this.backups.inspect(this.options.dbPath);
    if (version.appliedMigrations < version.availableMigrations) {
      const application = this.options.resources ? this.previousRelease() : undefined;
      const stage = this.stage();
      try {
        if (application) {
          const pair = await this.pair(application);
          await this.capture(join(pair, 'portfolio.sqlite'), stage);
        } else await this.capture(this.options.dbPath, stage);
        this.backups.prepare(stage);
        const previous = this.checkpoint();
        this.publish(stage, previous);
      } finally {
        if (!existsSync(this.pendingPath)) this.removeStage(stage);
      }
    }
    this.rememberRelease();
  }
  async recoverUpdate(
    directory: string,
    confirmation: string,
  ): Promise<{ launchPath: string; safetyBackup: string }> {
    if (confirmation !== 'RESTORE UPDATE BACKUP')
      throw new ProfileError(
        'CONFIRMATION_REQUIRED',
        'Подтвердите замену текущей базы восстановлением пары.',
      );
    absolutePath(directory);
    const parent = join(this.options.dataDir, 'backups');
    if (!realpathSync(directory).startsWith(realpathSync(parent) + '/'))
      throw new ProfileError(
        'INVALID_RECOVERY_PATH',
        'Выберите локальную пару из каталога backups этого профиля.',
      );
    const manifest = Pair.parse(JSON.parse(readFileSync(join(directory, 'recovery.json'), 'utf8')));
    const application = join(directory, 'application');
    const file = join(directory, 'portfolio.sqlite');
    let intact = false;
    try {
      intact =
        hashFile(file) === manifest.databaseSha256 &&
        this.releaseId(application) === manifest.applicationId &&
        (!manifest.applicationDigest ||
          this.runtimeDigest(application) === manifest.applicationDigest);
    } catch {
      /* Повреждённый комплект никогда не публикуется. */
    }
    if (!intact) {
      throw new ProfileError(
        'RECOVERY_DAMAGED',
        'Пара приложения и базы повреждена. Рабочая база сохранена.',
      );
    }
    const pairBackup = new PortfolioBackup(join(application, 'server/migrations'));
    const compatible = pairBackup.inspect(file);
    if (compatible.appliedMigrations !== compatible.availableMigrations)
      throw new ProfileError(
        'APPLICATION_MISMATCH',
        'Приложение не соответствует базе в выбранной паре.',
      );
    await validateRuntime(application, file);
    // После неудачной миграции рабочая БД может остаться в прежней схеме.
    // Страховочную пару создаём с подходящим приложением, без новых миграций.
    const candidates = [this.options.resources, application];
    try {
      candidates.unshift(this.previousRelease());
    } catch {
      /* Проверяем остальные варианты. */
    }
    const compatibleApplication = candidates.find((candidate) => {
      if (!candidate) return false;
      try {
        const version = new PortfolioBackup(join(candidate, 'server/migrations')).inspect(
          this.options.dbPath,
        );
        return version.appliedMigrations === version.availableMigrations;
      } catch {
        return false;
      }
    });
    if (!compatibleApplication)
      throw new ProfileError(
        'APPLICATION_MISMATCH',
        'Нет совместимого приложения для страховочной копии. Рабочая база сохранена.',
      );
    const safetyBackup = await this.pair(compatibleApplication);
    const stage = this.stage();
    try {
      await this.capture(file, stage); // Не применяем миграции новой версии при откате.
      const launchPath = join(application, 'start.sh');
      this.publish(stage, this.checkpoint(), { id: manifest.applicationId, launchPath });
      return { launchPath, safetyBackup };
    } finally {
      if (!existsSync(this.pendingPath)) this.removeStage(stage);
    }
  }
}
