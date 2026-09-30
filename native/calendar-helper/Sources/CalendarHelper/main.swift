import Foundation
import EventKit

/// calendar-helper — macOS EventKit calendar query CLI
///
/// Subcommands:
///   request-access                 — prompt for Calendar access. Exit 0 = granted, 2 = denied,
///                                    3 = not-determined (prompt deferred), 1 = error.
///   upcoming --window-minutes N    — JSON array of events starting within the next N minutes.
///   current                        — JSON object of the event whose [start, end] contains now, or `null`.
///
/// JSON output goes to stdout. Status messages go to stderr.
/// Exit codes: 0 = success, 1 = error, 2 = permission denied, 3 = not determined.

enum HelperError: Error {
    case permissionDenied
    case notDetermined
    case other(String)
}

/// Permission state we care about, normalised across macOS versions.
enum AccessState {
    case granted
    case denied
    case notDetermined
}

func currentAccessState() -> AccessState {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .notDetermined:
        return .notDetermined
    case .denied, .restricted:
        return .denied
    case .authorized:
        return .granted
    case .fullAccess:
        return .granted
    case .writeOnly:
        // Write-only access does not let us read events.
        return .denied
    @unknown default:
        return .denied
    }
}

func requestAccess(store: EKEventStore) async -> AccessState {
    if #available(macOS 14.0, *) {
        do {
            let granted = try await store.requestFullAccessToEvents()
            return granted ? .granted : .denied
        } catch {
            return .denied
        }
    } else {
        return await withCheckedContinuation { continuation in
            store.requestAccess(to: .event) { granted, _ in
                continuation.resume(returning: granted ? .granted : .denied)
            }
        }
    }
}

/// ISO-8601 with fractional seconds is overkill — minute precision is what callers need
/// for occurrence fingerprinting. Use a stable ISO formatter (UTC, second precision, no fractional).
let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone(secondsFromGMT: 0)
    return f
}()

func iso(_ date: Date) -> String {
    return isoFormatter.string(from: date)
}

func attendeeStatusString(_ status: EKParticipantStatus) -> String {
    switch status {
    case .unknown: return "unknown"
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in-process"
    @unknown default: return "unknown"
    }
}

func attendeeRoleString(_ role: EKParticipantRole) -> String {
    switch role {
    case .unknown: return "unknown"
    case .required: return "required"
    case .optional: return "optional"
    case .chair: return "chair"
    case .nonParticipant: return "non-participant"
    @unknown default: return "unknown"
    }
}

func emailFromURL(_ url: URL?) -> String? {
    guard let url = url else { return nil }
    let s = url.absoluteString
    if s.lowercased().hasPrefix("mailto:") {
        return String(s.dropFirst("mailto:".count))
    }
    return nil
}

func participantDict(_ p: EKParticipant) -> [String: Any] {
    var d: [String: Any] = [
        "role": attendeeRoleString(p.participantRole),
        "status": attendeeStatusString(p.participantStatus),
        "isCurrentUser": p.isCurrentUser
    ]
    let name = p.name ?? ""
    if !name.isEmpty { d["name"] = name } else { d["name"] = "" }
    if let email = emailFromURL(p.url) {
        d["email"] = email
    } else {
        d["email"] = ""
    }
    return d
}

/// Convert an EKEvent into the JSON-serialisable dictionary documented in the plan.
func eventDict(_ event: EKEvent) -> [String: Any] {
    let attendees: [[String: Any]] = (event.attendees ?? []).map { participantDict($0) }
    let declinedByMe: Bool = (event.attendees ?? []).contains { p in
        p.isCurrentUser && p.participantStatus == .declined
    }

    // Stable occurrence fingerprint: calendarItemIdentifier is stable across CalDAV resync,
    // and is the same across all occurrences of a recurring event — so we composite it with
    // the start time so each occurrence is uniquely addressable.
    let fingerprint = "cal:\(event.calendarItemIdentifier):\(iso(event.startDate))"

    var organiser: [String: Any] = [:]
    if let org = event.organizer {
        organiser["name"] = org.name ?? ""
        organiser["email"] = emailFromURL(org.url) ?? ""
    }

    return [
        "id": event.eventIdentifier ?? event.calendarItemIdentifier,
        "occurrenceFingerprint": fingerprint,
        "title": event.title ?? "",
        "startTime": iso(event.startDate),
        "endTime": iso(event.endDate),
        "isAllDay": event.isAllDay,
        "calendarTitle": event.calendar?.title ?? "",
        "organizer": organiser,
        "attendees": attendees,
        "notes": event.notes ?? "",
        "location": event.location ?? "",
        "declinedByMe": declinedByMe
    ]
}

func fetchUpcoming(store: EKEventStore, windowMinutes: Int) -> [EKEvent] {
    let now = Date()
    let end = now.addingTimeInterval(TimeInterval(windowMinutes * 60))
    let calendars = store.calendars(for: .event)
    let predicate = store.predicateForEvents(withStart: now, end: end, calendars: calendars)
    let events = store.events(matching: predicate)
    // EventKit returns events whose range overlaps the window. We want events that
    // *start* within the window (so we don't re-suggest meetings already underway).
    return events.filter { ev in
        ev.startDate >= now && ev.startDate <= end
    }.sorted { $0.startDate < $1.startDate }
}

func fetchCurrent(store: EKEventStore) -> EKEvent? {
    let now = Date()
    // 4-hour search window centred on "now" is plenty — the longest sane meeting is well within this.
    let start = now.addingTimeInterval(-2 * 3600)
    let end = now.addingTimeInterval(2 * 3600)
    let calendars = store.calendars(for: .event)
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate)
    return events.first { ev in
        ev.startDate <= now && ev.endDate > now && !ev.isAllDay
    }
}

func writeJSON(_ obj: Any) {
    do {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fputs("ERROR: Failed to serialise JSON: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

func usage() {
    fputs("""
    Usage:
      calendar-helper request-access
      calendar-helper upcoming --window-minutes N
      calendar-helper current

    """, stderr)
}

func ensureGranted(store: EKEventStore) -> Bool {
    switch currentAccessState() {
    case .granted:
        return true
    case .denied:
        fputs("ERROR: Calendar access denied\n", stderr)
        exit(2)
    case .notDetermined:
        fputs("ERROR: Calendar access not determined — run `calendar-helper request-access` first\n", stderr)
        exit(3)
    }
}

func run() async {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        usage()
        exit(1)
    }

    let subcommand = args[1]
    let store = EKEventStore()

    switch subcommand {
    case "request-access":
        let state = currentAccessState()
        if state == .granted {
            writeJSON(["status": "granted"])
            exit(0)
        }
        if state == .denied {
            writeJSON(["status": "denied"])
            exit(2)
        }
        // Not determined — actually trigger the prompt
        let result = await requestAccess(store: store)
        switch result {
        case .granted:
            writeJSON(["status": "granted"])
            exit(0)
        case .denied:
            writeJSON(["status": "denied"])
            exit(2)
        case .notDetermined:
            writeJSON(["status": "not-determined"])
            exit(3)
        }

    case "upcoming":
        _ = ensureGranted(store: store)
        var windowMinutes = 15
        var i = 2
        while i < args.count {
            switch args[i] {
            case "--window-minutes":
                if i + 1 < args.count, let v = Int(args[i + 1]) {
                    windowMinutes = v
                    i += 2
                } else {
                    fputs("ERROR: Invalid --window-minutes value\n", stderr)
                    exit(1)
                }
            default:
                fputs("WARNING: Unknown argument: \(args[i])\n", stderr)
                i += 1
            }
        }
        let events = fetchUpcoming(store: store, windowMinutes: windowMinutes)
        let dicts = events.map { eventDict($0) }
        writeJSON(dicts)
        exit(0)

    case "current":
        _ = ensureGranted(store: store)
        if let ev = fetchCurrent(store: store) {
            writeJSON(eventDict(ev))
        } else {
            // Print JSON null literal — easier than serialising NSNull
            FileHandle.standardOutput.write("null\n".data(using: .utf8)!)
        }
        exit(0)

    default:
        usage()
        exit(1)
    }
}

if #available(macOS 13.0, *) {
    Task {
        await run()
    }
    dispatchMain()
} else {
    fputs("ERROR: calendar-helper requires macOS 13.0 or later\n", stderr)
    exit(1)
}
