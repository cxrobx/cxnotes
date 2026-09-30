import Foundation
import AppKit
import ScreenCaptureKit

/// A resolution decision, carried through to the manifest so a session can
/// always answer "why did this capture what it captured".
///
/// The target is ALWAYS exactly one window. There is no application-wide case
/// and no display-wide case, because every widening of scope is a way for
/// something the user never meant to record to end up on disk. If a single
/// window cannot be named, the answer is to capture nothing.
struct Resolution {
    let window: SCWindow
    /// `meeting-window` | `shared-window`
    let mode: String
    let detail: String

    var windowID: CGWindowID { window.windowID }
    var describedTitle: String { window.title ?? "(untitled)" }
}

/// Why no frames will be captured. Being explicit about this is the point:
/// silence about a skipped capture reads exactly like a capture that worked.
struct ResolutionFailure: Error {
    let reason: String
}

/// Decides WHICH window frames may come from, and refuses rather than guess.
///
/// The invariant this type exists to hold: frame capture is never display-wide.
/// Every branch below resolves to a single window or a single application, so
/// whatever else is on screen — mail, Slack, a bank tab — is excluded by the
/// shape of the filter rather than by a policy we remember to apply. A user
/// looking at another program during a meeting is the normal case, not the edge
/// case, and window-scoped ScreenCaptureKit capture keeps returning the target
/// window's own content even when something else is in front of it.
@available(macOS 13.0, *)
struct SourceResolver {
    /// Applications that host a meeting natively. Audio coming from one of
    /// these is unambiguous: capture its window.
    static let meetingBundleIDs: Set<String> = [
        "us.zoom.xos",
        "com.microsoft.teams",
        "com.microsoft.teams2",
        "com.microsoft.SkypeForBusiness",
        "Cisco-Systems.Spark",
        "com.cisco.webexmeetingsapp",
        "com.apple.FaceTime",
        "com.tinyspeck.slackmacgap",
        "com.hnc.Discord"
    ]

    /// Browsers, where the meeting is a TAB and the OS can only see the window.
    static let browserBundleIDs: Set<String> = [
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.apple.Safari",
        "org.mozilla.firefox",
        "app.zen-browser.zen",
        "company.thebrowser.Browser",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.vivaldi.Vivaldi"
    ]

    /// Window-title fragments that mark a browser window as the meeting window.
    /// Matched case-insensitively. A browser window that does not match one of
    /// these is never captured, however loudly it is playing audio.
    static let meetingTitlePatterns: [String] = [
        "meet.google.com",
        "google meet",
        "meet –",
        "meet -",
        "meet —",
        "zoom meeting",
        "zoom.us",
        "microsoft teams",
        "teams.microsoft.com",
        "webex",
        "whereby",
        "gather",
        "around.co",
        "riverside.fm",
        "streamyard"
    ]

    /// Titles a screen-sharing indicator window carries. Their PRESENCE is the
    /// signal that the user is the one sharing — which matters because a sharer
    /// does not see their own slides inside the meeting window, they see them in
    /// Keynote or a browser, in a different application entirely.
    static let shareIndicatorPatterns: [String] = [
        "is sharing your screen",
        "sharing your screen",
        "screen sharing",
        "share statusbar",
        "share toolbar",
        "stop sharing",
        "you are sharing"
    ]

    /// Our own bundle, never a capture target.
    static let selfBundleIDs: Set<String> = [
        "com.christopherrobinson.cxnotes",
        "com.christopherrobinson.sck-slide-capture"
    ]

    let sourcePID: pid_t?
    let sourceBundleID: String?

    /// Diagnostic override: capture the one window whose title contains this,
    /// skipping audio-source resolution entirely.
    ///
    /// Exists for the same reason `--filter-shape` exists in the audio helper —
    /// the capture path can only be checked in situ, and waiting for a real
    /// meeting to check it is how a broken capture ships. It still resolves to
    /// exactly ONE window and still refuses an ambiguous match, so it widens
    /// nothing; it only changes how the window is chosen.
    var windowTitleOverride: String?

    /// Resolve the current capture target.
    ///
    /// - Parameters:
    ///   - content: A fresh `SCShareableContent` enumeration
    ///   - lockedShareWindowID: The window latched at the moment sharing began,
    ///     so alt-tabbing away mid-share does not repoint the capture
    /// - Returns: The resolution, plus the share window to latch (if any)
    func resolve(
        content: SCShareableContent,
        lockedShareWindowID: CGWindowID?
    ) throws -> (resolution: Resolution, shareWindowID: CGWindowID?) {
        if let needle = windowTitleOverride {
            let matches = content.windows.filter { window in
                guard window.isOnScreen, let title = window.title, !title.isEmpty else { return false }
                return title.localizedCaseInsensitiveContains(needle)
            }
            guard matches.count == 1, let window = matches.first else {
                throw ResolutionFailure(reason: matches.isEmpty
                    ? "no on-screen window title contains \"\(needle)\""
                    : "\(matches.count) windows match \"\(needle)\"; refusing to guess")
            }
            return (
                Resolution(window: window, mode: "diagnostic-window", detail: "title override matched \"\(window.title ?? "")\""),
                nil
            )
        }

        guard let app = matchAudioSource(in: content) else {
            throw ResolutionFailure(reason: "no running application matched the meeting audio source")
        }

        let ownWindows = content.windows.filter { $0.owningApplication?.processID == app.processID }

        // Is the user sharing? If so their slides live outside the meeting app.
        if isSharing(content: content, meetingApp: app) {
            if let locked = lockedShareWindowID,
               let window = content.windows.first(where: { $0.windowID == locked }),
               window.isOnScreen {
                return (
                    Resolution(
                        window: window,
                        mode: "shared-window",
                        detail: "latched to \"\(window.title ?? "untitled")\" for the duration of the share"
                    ),
                    locked
                )
            }

            if let presented = presentedWindow(content: content, meetingApp: app) {
                return (
                    Resolution(
                        window: presented,
                        mode: "shared-window",
                        detail: "\(app.applicationName) is sharing; capturing the presented window \"\(presented.title ?? "untitled")\""
                    ),
                    presented.windowID
                )
            }
            // Sharing, but the presented window could not be identified — fall
            // through to the meeting window rather than reach for the display.
        }

        let isBrowser = Self.browserBundleIDs.contains(app.bundleIdentifier)

        if isBrowser {
            let candidates = ownWindows.filter { window in
                guard window.isOnScreen, let title = window.title, !title.isEmpty else { return false }
                return Self.matchesMeetingTitle(title)
            }

            guard candidates.count == 1, let window = candidates.first else {
                throw ResolutionFailure(reason: candidates.isEmpty
                    ? "\(app.applicationName) holds the meeting audio but no window title identifies a meeting — a browser tab is invisible to the OS, so nothing is captured"
                    : "\(candidates.count) windows in \(app.applicationName) look like meetings; refusing to guess which one is this meeting")
            }

            return (
                Resolution(
                    window: window,
                    mode: "meeting-window",
                    detail: "browser window \"\(window.title ?? "")\" matched a meeting title"
                ),
                nil
            )
        }

        // Native meeting app — its largest on-screen window is the meeting.
        guard let window = largestOnScreenWindow(ownWindows) else {
            // Running but not in a meeting: Zoom sits in the background for days
            // with only a menu-bar item and a contacts panel. Capturing "the
            // app" here would film the contact list, so capture nothing.
            throw ResolutionFailure(reason: "\(app.applicationName) is running but has no meeting window on screen")
        }

        return (
            Resolution(
                window: window,
                mode: "meeting-window",
                detail: "\(app.applicationName) window \"\(window.title ?? "untitled")\""
            ),
            nil
        )
    }

    /// Find the application the meeting audio is coming from.
    private func matchAudioSource(in content: SCShareableContent) -> SCRunningApplication? {
        if let pid = sourcePID,
           let match = content.applications.first(where: { $0.processID == pid }) {
            return match
        }
        if let bundleID = sourceBundleID,
           let match = content.applications.first(where: { $0.bundleIdentifier == bundleID }) {
            return match
        }
        // No hint from the caller — accept a native meeting app if exactly one
        // is running, and never fall back to "some browser".
        let meetings = content.applications.filter { Self.meetingBundleIDs.contains($0.bundleIdentifier) }
        return meetings.count == 1 ? meetings.first : nil
    }

    /// Does a screen-sharing indicator exist right now?
    private func isSharing(content: SCShareableContent, meetingApp: SCRunningApplication) -> Bool {
        content.windows.contains { window in
            guard let title = window.title?.lowercased(), !title.isEmpty else { return false }
            guard Self.shareIndicatorPatterns.contains(where: { title.contains($0) }) else { return false }
            // Only trust an indicator owned by the meeting app or the browser
            // hosting it — other apps say "screen sharing" for other reasons.
            guard let owner = window.owningApplication else { return false }
            return owner.processID == meetingApp.processID
                || Self.browserBundleIDs.contains(owner.bundleIdentifier)
                || Self.meetingBundleIDs.contains(owner.bundleIdentifier)
        }
    }

    /// The window the user appears to be presenting FROM: the frontmost window
    /// that is neither the meeting app nor us.
    private func presentedWindow(content: SCShareableContent, meetingApp: SCRunningApplication) -> SCWindow? {
        let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

        let candidates = content.windows.filter { window in
            guard window.isOnScreen, let owner = window.owningApplication else { return false }
            guard owner.processID != meetingApp.processID else { return false }
            guard !Self.selfBundleIDs.contains(owner.bundleIdentifier) else { return false }
            guard owner.bundleIdentifier != "com.apple.finder" || (window.title?.isEmpty == false) else { return false }
            // Ignore menu-bar sized slivers and sharing indicators.
            guard window.frame.width > 320, window.frame.height > 240 else { return false }
            if let title = window.title?.lowercased(),
               Self.shareIndicatorPatterns.contains(where: { title.contains($0) }) {
                return false
            }
            return true
        }

        if let frontPID, let front = candidates.first(where: { $0.owningApplication?.processID == frontPID }) {
            return front
        }
        // `content.windows` is ordered front to back, so the first survivor is
        // the frontmost thing that is not the meeting app.
        return candidates.first
    }

    private func largestOnScreenWindow(_ windows: [SCWindow]) -> SCWindow? {
        windows
            .filter { $0.isOnScreen && $0.frame.width > 320 && $0.frame.height > 240 }
            .max { lhs, rhs in
                (lhs.frame.width * lhs.frame.height) < (rhs.frame.width * rhs.frame.height)
            }
    }

    static func matchesMeetingTitle(_ title: String) -> Bool {
        let lowered = title.lowercased()
        return meetingTitlePatterns.contains { lowered.contains($0) }
    }
}
