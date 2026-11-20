import AppKit
import ApplicationServices
import CryptoKit
import EventKit

func jarvisInput() -> [String: Any]? {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard bytes.count <= 48_000 else { return nil }
    return (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
}

func createJarvisEvent() -> [String: Any] {
    guard let input = jarvisInput(), let title = input["title"] as? String,
          !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf8.count <= 4000,
          let a = input["start"] as? String, let b = input["end"] as? String,
          let zone = input["zone"] as? String, let tz = TimeZone(identifier: zone),
          let guests = input["attendees"] as? [String], guests.isEmpty else { return ["ok": false] }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let start = iso.date(from: a), let end = iso.date(from: b), end > start else { return ["ok": false] }

    let store = EKEventStore()
    let permission = EKEventStore.authorizationStatus(for: .event)
    if permission == .denied || permission == .restricted { return ["ok": false, "permission": true] }
    if permission == .notDetermined {
        var result: Bool?
        let complete: (Bool, Error?) -> Void = { granted, _ in DispatchQueue.main.async { result = granted } }
        if #available(macOS 14, *) { store.requestWriteOnlyAccessToEvents(completion: complete) }
        else { store.requestAccess(to: .event, completion: complete) }
        let deadline = Date().addingTimeInterval(25)
        while result == nil && Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.2))
        }
        guard result == true else { return ["ok": false, "permission": true] }
    }
    guard let calendar = store.defaultCalendarForNewEvents else { return ["ok": false, "permission": true] }
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = title
    event.startDate = start
    event.endDate = end
    event.timeZone = tz
    do {
        try store.save(event, span: .thisEvent, commit: true)
        if let identifier = event.eventIdentifier, !identifier.isEmpty { return ["ok": true, "identifier": identifier] }
        return ["ok": false]
    } catch { return ["ok": false] }
}

private struct JarvisSelection {
    let field: AXUIElement
    let app: NSRunningApplication
    let stamp: String
    let selected: String
    let full: String
    let range: CFRange
    let title: String

    var info: [String: Any] {
        ["pid": app.processIdentifier, "stamp": stamp, "text": selected, "app": app.localizedName ?? "Editor", "title": title]
    }
}

private func jarvisSelection(_ pid: pid_t) -> JarvisSelection? {
    guard AXIsProcessTrusted(), !isRoamies(pid), let app = NSRunningApplication(processIdentifier: pid),
          handsOff(pid) == nil, let bundle = app.bundleIdentifier,
          !bundle.lowercased().contains("password") else { return nil }
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(ax, 0.4)
    guard let winValue = attr(ax, kAXFocusedWindowAttribute), CFGetTypeID(winValue) == AXUIElementGetTypeID(),
          let fieldValue = attr(ax, kAXFocusedUIElementAttribute), CFGetTypeID(fieldValue) == AXUIElementGetTypeID() else { return nil }
    let window = winValue as! AXUIElement
    let field = fieldValue as! AXUIElement
    guard let role = str(field, kAXRoleAttribute), ["AXTextArea", "AXTextField"].contains(role),
          str(field, kAXSubroleAttribute) != "AXSecureTextField",
          let selected = str(field, kAXSelectedTextAttribute), !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          selected.utf8.count <= 20_000,
          let full = str(field, kAXValueAttribute), full.utf8.count <= 2_000_000,
          let value = attr(field, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID(),
          let bounds = frameOf(attr(field, kAXPositionAttribute), attr(field, kAXSizeAttribute)),
          let id = mainWindow(windows().filter { $0.pid == pid })?.id else { return nil }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range),
          range.location >= 0, range.length > 0, range.location <= full.utf16.count,
          range.length <= full.utf16.count - range.location,
          (full as NSString).substring(with: NSRange(location: range.location, length: range.length)) == selected else { return nil }
    let title = str(window, kAXTitleAttribute) ?? ""
    let identifier = str(field, kAXIdentifierAttribute) ?? ""
    let input = "\(pid)|\(id)|\(bundle)|\(title)|\(role)|\(identifier)|\(bounds)|\(range.location)|\(range.length)|\(full)"
    let stamp = SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    return JarvisSelection(field: field, app: app, stamp: stamp, selected: selected, full: full, range: range, title: title)
}

func readJarvisSelection() -> [String: Any] {
    guard let pid = frontPid(), let snapshot = jarvisSelection(pid) else { return ["ok": false] }
    return ["ok": true, "selection": snapshot.info]
}

func replaceJarvisSelection() -> [String: Any] {
    guard let input = jarvisInput(), let pid = input["pid"] as? Int32, pid > 0,
          let stamp = input["stamp"] as? String, let newText = input["text"] as? String,
          !newText.isEmpty, newText.utf8.count <= 20_000,
          let snapshot = jarvisSelection(pid), snapshot.stamp == stamp else { return ["ok": false] }
    if frontPid() != pid {
        guard snapshot.app.activate(options: []) else { return ["ok": false] }
        let deadline = Date().addingTimeInterval(0.6)
        while frontPid() != pid && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    }
    guard frontPid() == pid, jarvisSelection(pid)?.stamp == stamp else { return ["ok": false] }
    let board = NSPasteboard.general
    let previous = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    }
    board.clearContents()
    guard board.setString(newText, forType: .string) else { return ["ok": false] }
    let paste = board.changeCount
    defer {
        if board.changeCount == paste {
            board.clearContents()
            if !previous.isEmpty { _ = board.writeObjects(previous) }
        }
    }
    guard frontPid() == pid, jarvisSelection(pid)?.stamp == stamp,
          let keyDown = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false) else { return ["ok": false] }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    keyDown.postToPid(pid)
    keyUp.postToPid(pid)
    let expected = (snapshot.full as NSString).replacingCharacters(in: NSRange(location: snapshot.range.location, length: snapshot.range.length), with: newText)
    let deadline = Date().addingTimeInterval(1.2)
    while Date() < deadline {
        if str(snapshot.field, kAXValueAttribute) == expected { return ["ok": true] }
        Thread.sleep(forTimeInterval: 0.03)
    }
    return ["ok": false, "attempted": true]
}
