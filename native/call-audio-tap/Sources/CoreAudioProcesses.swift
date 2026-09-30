import Foundation
import CoreAudio

/// Read-only lookups over Core Audio's process objects.
///
/// Nothing here creates a device or a tap. This is the whole of what the helper
/// does while no call is running, and it is exactly what the T206 spike ran
/// through a Zoom and a Meet call without `avconferenced` ever moving.
enum CoreAudioProcesses {
    /// The daemon that plays the remote party on iPhone-handoff and FaceTime
    /// calls. ScreenCaptureKit cannot hear it with either filter shape.
    static let callDaemonBundleID = "com.apple.avconferenced"
    static let callDaemonName = "avconferenced"

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    static func processObjects() -> [AudioObjectID] {
        var addr = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func pid(of object: AudioObjectID) -> pid_t? {
        var addr = address(kAudioProcessPropertyPID)
        var value: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
    }

    static func bundleID(of object: AudioObjectID) -> String? {
        var addr = address(kAudioProcessPropertyBundleID)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr,
              let string = value?.takeRetainedValue() else { return nil }
        return string as String
    }

    static func name(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 1024)
        return proc_name(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
    }

    /// `nil` when the property cannot be read — the object has gone, or the
    /// daemon restarted and the id is stale. The caller re-resolves.
    static func isRunningOutput(_ object: AudioObjectID) -> Bool? {
        var addr = address(kAudioProcessPropertyIsRunningOutput)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value != 0
    }

    /// The call daemon's process object. Measured on macOS 14.5 it is listed
    /// even when idle, so this normally resolves before any call starts.
    static func callDaemon() -> AudioObjectID? {
        for object in processObjects() {
            if bundleID(of: object) == callDaemonBundleID { return object }
            if let p = pid(of: object), name(of: p) == callDaemonName { return object }
        }
        return nil
    }

    static func processObject(for pid: pid_t) -> AudioObjectID? {
        var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var pid = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr,
            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }
}
