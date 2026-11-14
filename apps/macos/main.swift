import Cocoa
import ServiceManagement
import Darwin

// AppKit + Swift 5: поддерживаем macOS 13, без внешних UI-зависимостей.
final class PortfolioApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let fm = FileManager.default
    let bundle = Bundle.main
    var item: NSStatusItem!
    var menu = NSMenu()
    var onboarding: NSWindow?
    var process: Process?
    var operation: Process?
    var logHandle: FileHandle?
    var timer: Timer?
    var controlTimer: Timer?
    var activity: NSObjectProtocol?
    var lockFD: Int32 = -1
    var state = "Остановлен"
    var reason = ""
    var busy = false
    var stopping = false
    var quitting = false
    var ready = false
    var instance = ""
    var started = Date()
    var runtime: URL!
    var data: URL!
    var control: URL?
    var noBrowser = false
    var port = 3000
    var version: String { bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
    var build: String { bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }
    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }
    var logURL: URL { data.appendingPathComponent("logs/app.log") }
    var testProfile: Bool { CommandLine.arguments.contains("--test-profile") }
    func argument(_ key: String) -> String? {
        guard let i = CommandLine.arguments.firstIndex(of: key), i + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[i + 1]
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        runtime = bundle.resourceURL!.appendingPathComponent("Runtime")
        data = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Investment Portfolio")
        // Изолированный стенд приёмки. Finder по умолчанию всегда использует стабильный профиль.
        if let path = argument("--test-profile"), path.hasPrefix("/") {
            data = URL(fileURLWithPath: path)
            noBrowser = CommandLine.arguments.contains("--no-browser")
            if let number = argument("--test-port").flatMap(Int.init), (1024...65535).contains(number) { port = number }
            if let path = argument("--test-control"), path.hasPrefix("/") { control = URL(fileURLWithPath: path) }
        }
        do {
            try fm.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            lockFD = Darwin.open(data.appendingPathComponent(".menu-app.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
                alert("Приложение уже открыто", "Используйте значок портфеля в строке меню.")
                NSApp.terminate(nil); return
            }
            if let control { try fm.createDirectory(at: control, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        } catch { alert("Не удалось открыть профиль", "Проверьте права доступа и свободное место."); NSApp.terminate(nil); return }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "chart.pie.fill", accessibilityDescription: "Investment Portfolio")
        item.menu = menu
        menu.delegate = self
        refreshMenu()
        if control != nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Изолированная приёмка приложения")
            let poll = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in self?.pollControl() }
            RunLoop.main.add(poll, forMode: .common); controlTimer = poll
        }
        profile("status") { result in
            guard let result else { return }
            if result["exists"] as? Bool == true {
                self.startCompatibleServer()
            } else { self.showOnboarding() }
        }
    }
    func add(_ title: String, _ action: Selector? = nil, enabled: Bool = true) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self; entry.isEnabled = enabled; menu.addItem(entry)
    }
    func menuWillOpen(_ menu: NSMenu) { refreshMenu() }
    func refreshMenu() {
        guard item != nil else { return }
        menu.removeAllItems(); menu.autoenablesItems = false
        let channel = bundle.object(forInfoDictionaryKey: "PortfolioBuildChannel") as? String ?? "release"
        add("Investment Portfolio \(version) (\(build))\(channel == "release" ? "" : " · " + channel)")
        add(state)
        if !reason.isEmpty { add(String(reason.prefix(150))) }
        menu.addItem(.separator())
        add("Запустить", #selector(startAction), enabled: process == nil && !busy)
        add("Остановить", #selector(stopAction), enabled: process != nil && !stopping)
        add("Открыть портфель", #selector(openPortfolio), enabled: ready)
        add("Первый запуск…", #selector(showOnboarding), enabled: process == nil && !busy)
        add("Перенести токен T-Invest…", #selector(importToken), enabled: process == nil && !busy)
        add("Вернуться к версии до обновления…", #selector(recover), enabled: process == nil && !busy)
        menu.addItem(.separator())
        let login = SMAppService.mainApp.status
        let label: String
        switch login {
        case .enabled: label = "Запускать при входе ✓"
        case .requiresApproval: label = "Запуск при входе: требуется разрешение…"
        case .notRegistered: label = "Запускать при входе"
        default: label = "Запуск при входе: недоступен"
        }
        add(label, #selector(toggleLogin), enabled: !testProfile)
        add("Разрешение в настройках macOS…", #selector(loginSettings))
        add("Открыть логи", #selector(openLogs))
        add("О программе…", #selector(about))
        add("Выйти", #selector(quit))
        item.button?.toolTip = "Investment Portfolio \(version) — \(state)"
        snapshot()
    }
    func snapshot() {
        guard let control else { return }
        let object: [String: Any] = ["version": version, "build": build, "state": state, "error": reason,
            "ready": ready, "busy": busy, "onboarding": onboarding != nil, "pid": ProcessInfo.processInfo.processIdentifier,
            "serverPid": process?.processIdentifier ?? 0, "instance": instance, "port": port, "runtime": runtime.path]
        if let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
            try? bytes.write(to: control.appendingPathComponent("state.json"), options: .atomic)
        }
    }
    func environment() -> [String: String] {
        // Не наследуем dev-пути, NODE_OPTIONS или токены из shell/launchd.
        var env = ["HOME": fm.homeDirectoryForCurrentUser.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                   "LANG": "ru_RU.UTF-8", "DATA_DIR": data.path, "ENV_FILE": data.appendingPathComponent(".env").path,
                   "PORT": String(port), "APP_INSTANCE_ID": instance, "APP_VERSION": version, "APP_BUILD": build,
                   "PORTFOLIO_OWNER_PID": String(ProcessInfo.processInfo.processIdentifier)]
        env["TMPDIR"] = NSTemporaryDirectory()
        return env
    }
    func profile(_ action: String, _ input: [String: Any] = [:], completion: @escaping ([String: Any]?) -> Void) {
        guard !busy && process == nil else { return }
        busy = true; reason = ""; refreshMenu()
        // Команды профиля всегда исполняет текущая версия, даже если HTTP-сервер
        // выбран из сохранённой пары и ещё не знает новых команд мастера.
        let task = Process(); task.executableURL = bundle.resourceURL!.appendingPathComponent("Runtime/start.sh")
        task.arguments = ["profile", action]; task.environment = environment(); task.currentDirectoryURL = data
        let stdin = Pipe(); let stdout = Pipe(); let stderr = Pipe()
        task.standardInput = stdin; task.standardOutput = stdout; task.standardError = stderr
        operation = task
        do { try task.run() } catch { operation = nil; busy = false; fail("Не удалось запустить встроенный сервер. Переустановите приложение."); completion(nil); return }
        let bytes = (try? JSONSerialization.data(withJSONObject: input)) ?? Data()
        stdin.fileHandleForWriting.write(bytes); try? stdin.fileHandleForWriting.close()
        DispatchQueue.global().async {
            let output = stdout.fileHandleForReading.readDataToEndOfFile()
            let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let response = (try? JSONSerialization.jsonObject(with: task.terminationStatus == 0 ? output : errorOutput)) as? [String: Any]
            DispatchQueue.main.async {
                self.operation = nil; self.busy = false
                if self.quitting { NSApp.reply(toApplicationShouldTerminate: true); return }
                if task.terminationStatus == 0, let result = response?["result"] as? [String: Any] {
                    self.refreshMenu(); completion(result)
                } else {
                    let failure = response?["error"] as? [String: Any]
                    self.fail(failure?["message"] as? String ?? "Не удалось подготовить профиль. Проверьте файл, версию приложения, права и свободное место. Подробности: \(self.logURL.path)")
                    completion(nil)
                }
            }
        }
    }
    func fail(_ text: String) { state = "Ошибка"; reason = text; ready = false; refreshMenu() }
    func portAvailable() -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { return false }; defer { close(fd) }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in(); addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian; addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }
    @objc func startAction() {
        profile("status") { result in
            guard let result else { return }
            if result["exists"] as? Bool == true { self.startCompatibleServer() } else { self.showOnboarding() }
        }
    }
    func startCompatibleServer() {
        profile("resolve-start") { result in
            guard let result else { return }
            if let path = result["launchPath"] as? String {
                self.runtime = URL(fileURLWithPath: path).deletingLastPathComponent()
            } else {
                self.runtime = self.bundle.resourceURL!.appendingPathComponent("Runtime")
            }
            self.startServer()
        }
    }
    func startServer() {
        guard process == nil && !busy && !quitting else { return }
        guard portAvailable() else { fail("Порт \(port) занят другим процессом. Закройте использующее его приложение и повторите. Чужой процесс не остановлен."); return }
        onboarding?.close(); onboarding = nil
        instance = UUID().uuidString; state = "Запускается"; reason = ""; stopping = false; ready = false; started = Date()
        let task = Process(); task.executableURL = runtime.appendingPathComponent("start.sh")
        task.environment = environment(); task.currentDirectoryURL = data
        do {
            // Один файл логов; секреты и JSON переноса токена сюда не пишутся.
            if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let handle = try FileHandle(forWritingTo: logURL); try handle.seekToEnd(); logHandle = handle
            handle.write(Data("\n=== \(Date()) Investment Portfolio \(version) (\(build)) ===\n".utf8))
            task.standardOutput = handle; task.standardError = handle; task.standardInput = FileHandle.nullDevice
            task.terminationHandler = { [weak self] ended in
                DispatchQueue.main.async { self?.serverEnded(ended) }
            }
            process = task; try task.run()
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.probe() }
            refreshMenu(); probe()
        } catch {
            process = nil; try? logHandle?.close(); logHandle = nil
            fail("Встроенный сервер не запускается. Переустановите приложение; логи: \(logURL.path)")
        }
    }
    func probe() {
        guard let task = process, task.isRunning, !stopping else { return }
        if !ready && Date().timeIntervalSince(started) > 180 {
            reason = "Сервер не подтвердил готовность за 180 секунд. Проверьте логи и повторите запуск."; stopServer(); return
        }
        let expected = instance
        var request = URLRequest(url: base.appendingPathComponent("api/health")); request.timeoutInterval = 2; request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { bytes, response, _ in
            guard let bytes, let value = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { return }
            DispatchQueue.main.async {
                guard self.process === task, task.isRunning, self.instance == expected, !self.stopping else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, value["instance"] as? String == expected else { return }
                if !self.ready {
                    self.ready = true; self.state = "Работает"; self.refreshMenu()
                    if !self.noBrowser { self.openPortfolio() }
                }
            }
        }.resume()
    }
    func serverEnded(_ task: Process) {
        guard process === task else { return }
        timer?.invalidate(); timer = nil; process = nil; ready = false
        try? logHandle?.close(); logHandle = nil
        if stopping { state = reason.isEmpty ? "Остановлен" : "Ошибка" }
        else {
            state = "Ошибка"
            // Последняя структурированная ошибка безопасна: сервер не выводит исходные исключения/секреты.
            let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
            let last = text.split(separator: "\n").reversed().compactMap { line -> String? in
                guard let bytes = String(line).data(using: .utf8), let json = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], let error = json["error"] as? [String: Any] else { return nil }
                return error["message"] as? String
            }.first
            reason = last ?? "Сервер завершился (код \(task.terminationStatus)). Логи: \(logURL.path). Для возврата используйте «Вернуться к версии до обновления…»."
        }
        stopping = false; refreshMenu()
        if quitting { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    func stopServer() {
        guard let task = process else { return }
        stopping = true; ready = false; state = "Останавливается"; timer?.invalidate(); refreshMenu()
        if task.isRunning { task.terminate() }
        // Не убиваем принудительно: оболочка должна дождаться закрытия HTTP/SQLite.
    }
    @objc func stopAction() { reason = ""; stopServer() }
    @objc func openPortfolio() { if ready, process?.isRunning == true { NSWorkspace.shared.open(base) } }
    @objc func openLogs() { NSWorkspace.shared.open(logURL.deletingLastPathComponent()) }
    @objc func about() { alert("Investment Portfolio \(version)", "Сборка \(build)\nApple Silicon · macOS 13+\nПрофиль: \(data.path)\nСервер: \(runtime.path)") }
    @objc func loginSettings() { SMAppService.openSystemSettingsLoginItems() }
    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else if SMAppService.mainApp.status == .requiresApproval { loginSettings() }
            else { try SMAppService.mainApp.register() }
            refreshMenu()
        } catch { alert("Не удалось изменить автозапуск", error.localizedDescription) }
    }
    func alert(_ title: String, _ message: String) { NSApp.activate(ignoringOtherApps: true); let a = NSAlert(); a.messageText = title; a.informativeText = message; a.runModal() }
    @objc func showOnboarding() {
        guard process == nil && !busy else { return }
        if let onboarding { onboarding.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Investment Portfolio — первый запуск"; window.isReleasedWhenClosed = false
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField(wrappingLabelWithString: "Выберите способ подготовки портфеля. Существующая база не будет перезаписана.\n\nПрофиль: \(data.path)")
        stack.addArrangedSubview(label)
        for (title, selector) in [("Восстановить из резервной копии…", #selector(restore)), ("Начать с пустого", #selector(empty)), ("Перенести из старого проекта…", #selector(importProject)), ("Позже", #selector(closeOnboarding))] {
            let button = NSButton(title: title, target: self, action: selector); stack.addArrangedSubview(button)
        }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
        onboarding = window; window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); snapshot()
    }
    @objc func closeOnboarding() { onboarding?.close(); onboarding = nil; snapshot() }
    func select(directory: Bool, title: String, initial: URL? = nil) -> URL? {
        let panel = NSOpenPanel(); panel.title = title; panel.canChooseDirectories = directory; panel.canChooseFiles = !directory; panel.allowsMultipleSelection = false; panel.directoryURL = initial
        NSApp.activate(ignoringOtherApps: true)
        return panel.runModal() == .OK ? panel.url : nil
    }
    func confirm(_ title: String, _ message: String) -> Bool {
        let a = NSAlert(); a.messageText = title; a.informativeText = message; a.addButton(withTitle: "Продолжить"); a.addButton(withTitle: "Отмена")
        NSApp.activate(ignoringOtherApps: true); return a.runModal() == .alertFirstButtonReturn
    }
    @objc func empty() { initialize("init-empty", [:]) }
    func initialize(_ action: String, _ input: [String: Any]) {
        profile(action, input) { result in
            if let result {
                self.closeOnboarding()
                if self.control == nil { self.alert("Профиль подготовлен", "\(result["databasePath"] ?? self.data.path)\nСчета: \(result["accounts"] ?? 0), операции: \(result["operations"] ?? 0), системы: \(result["systems"] ?? 0)") }
                self.startServer()
            } else if self.control == nil { self.alert("Не удалось подготовить профиль", self.reason) }
        }
    }
    @objc func restore() {
        guard let url = select(directory: false, title: "Выберите резервную копию SQLite") else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        profile("inspect", ["source": url.path]) { result in
            guard let result else { if scoped { url.stopAccessingSecurityScopedResource() }; self.alert("Файл не принят", self.reason); return }
            let yes = self.confirm("Восстановить портфель?", "\(url.path)\nСчета: \(result["accounts"] ?? 0), операции: \(result["operations"] ?? 0).\nИсходный файл останется на месте.")
            if yes { self.initialize("restore", ["source": url.path]) }
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
    }
    @objc func importProject() {
        guard let url = select(directory: true, title: "Выберите каталог старого проекта") else { return }
        if confirm("Перенести портфель?", "\(url.path)\nПуть базы определяется настройками старого проекта. Токен переносится отдельно.") { initialize("import-project", ["projectRoot": url.path]) }
    }
    @objc func importToken() {
        guard let url = select(directory: false, title: "Выберите старый .env с TBANK_TOKEN") else { return }
        guard confirm("Перенести только токен T-Invest?", "\(url.path)\nДругие настройки не переносятся. Подтвердите также замену ранее настроенного токена, если он есть.") else { return }
        profile("import-tinvest", ["sourceEnvFile": url.path, "confirmation": "IMPORT TBANK_TOKEN", "replaceExisting": true]) { result in
            if result != nil { self.alert("Токен сохранён", "Настройка применится при следующем запуске сервера.") } else { self.alert("Токен не перенесён", self.reason) }
        }
    }
    @objc func recover() {
        guard let url = select(directory: true, title: "Выберите пару update-…", initial: data.appendingPathComponent("backups")) else { return }
        guard confirm("Вернуться к портфелю до обновления?", "\(url.path)\nТекущий портфель будет сохранён отдельной страховочной парой. Запустится сервер прежней версии.") else { return }
        performRecovery(url.path)
    }
    func performRecovery(_ directory: String) {
        profile("recover-update", ["directory": directory, "confirmation": "RESTORE UPDATE BACKUP"]) { result in
            guard let path = result?["launchPath"] as? String else { return }
            self.runtime = URL(fileURLWithPath: path).deletingLastPathComponent(); self.startServer()
        }
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        if operation != nil { return .terminateLater }
        if process != nil { stopServer(); return .terminateLater }
        return .terminateNow
    }
    func applicationWillTerminate(_ notification: Notification) {
        if lockFD >= 0 { close(lockFD) }; controlTimer?.invalidate()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
    }
    // Файловый адаптер приёмки включается только вместе с явно заданным временным профилем.
    // Вызывает те же действия, что кнопки; не меняет БД и не имитирует готовность сервера.
    func pollControl() {
        guard let control else { return }; snapshot()
        let path = control.appendingPathComponent("command.json")
        guard let bytes = try? Data(contentsOf: path), let request = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: String], let action = request["action"] else { return }
        if busy && action != "quit" { return }
        try? fm.removeItem(at: path)
        switch action {
        case "start": startAction()
        case "stop": stopAction()
        case "quit": quit()
        case "init-empty": empty()
        case "restore": if let source = request["source"] { initialize("restore", ["source": source]) }
        case "import-project": if let source = request["source"] { initialize("import-project", ["projectRoot": source]) }
        case "recover": if let source = request["source"] { performRecovery(source) }
        default: break
        }
    }
}
let app = NSApplication.shared
let delegate = PortfolioApp()
app.delegate = delegate
app.run()
