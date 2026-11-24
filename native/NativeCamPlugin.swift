import Foundation
import UIKit
import Capacitor
import AVFoundation
import Photos

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// מצלמה נייטיבית של האייפון (AVFoundation) - בלי MediaRecorder של ספארי, ולכן בלי דיליי.
/// התצוגה החיה יושבת מאחורי ה-WebView, והטקסט של הפרומפטר מצויר מעליה.
@objc(NativeCamPlugin)
public class NativeCamPlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureFileOutputRecordingDelegate {
    public let identifier = "NativeCamPlugin"
    public let jsName = "NativeCam"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMirror", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportToPhotos", returnType: CAPPluginReturnPromise),
    ]

    private let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "teleprompter.camera")
    private var previewView: PreviewView?
    private var configured = false
    private var mirror = true
    private var stopCall: CAPPluginCall?

    private var cameraDevice: AVCaptureDevice?
    private var rotationStore: Any?

    private func setPortrait(_ conn: AVCaptureConnection) {
        if #available(iOS 17.0, *) {
            conn.videoRotationAngle = 90
        } else if conn.isVideoOrientationSupported {
            conn.videoOrientation = .portrait
        }
    }

    /// כיוון נכון לתצוגה ולקובץ (אנכי). ב-iOS 17 ומעלה משתמשים ב-RotationCoordinator של אפל.
    private func updateRotation() {
        let previewConn = previewView?.previewLayer.connection
        let movieConn = movieOutput.connection(with: .video)
        if #available(iOS 17.0, *) {
            if let cam = cameraDevice, let layer = previewView?.previewLayer {
                let rc: AVCaptureDevice.RotationCoordinator
                if let existing = rotationStore as? AVCaptureDevice.RotationCoordinator {
                    rc = existing
                } else {
                    rc = AVCaptureDevice.RotationCoordinator(device: cam, previewLayer: layer)
                    rotationStore = rc
                }
                previewConn?.videoRotationAngle = rc.videoRotationAngleForHorizonLevelPreview
                movieConn?.videoRotationAngle = rc.videoRotationAngleForHorizonLevelCapture
                return
            }
        }
        if let c = previewConn { setPortrait(c) }
        if let c = movieConn { setPortrait(c) }
    }

    private func configureIfNeeded() throws {
        if configured { return }
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: cam), session.canAddInput(input) else {
            session.commitConfiguration()
            throw NSError(domain: "cam", code: 1, userInfo: [NSLocalizedDescriptionKey: "לא נמצאה מצלמה קדמית"])
        }
        session.addInput(input)
        cameraDevice = cam
        if let mic = AVCaptureDevice.default(for: .audio),
           let audioIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(audioIn) {
            session.addInput(audioIn)
        }
        guard session.canAddOutput(movieOutput) else {
            session.commitConfiguration()
            throw NSError(domain: "cam", code: 2, userInfo: [NSLocalizedDescriptionKey: "לא ניתן להקליט"])
        }
        session.addOutput(movieOutput)
        if let conn = movieOutput.connection(with: .video) {
            setPortrait(conn)
            if movieOutput.availableVideoCodecTypes.contains(.h264) {
                movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: conn)
            }
        }
        session.commitConfiguration()
        // נעילה על 30 פריימים קבועים
        do {
            try cam.lockForConfiguration()
            cam.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
            cam.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
            cam.unlockForConfiguration()
        } catch {}
        configured = true
    }

    private func applyMirror() {
        guard let conn = previewView?.previewLayer.connection else { return }
        if conn.isVideoMirroringSupported {
            conn.automaticallyAdjustsVideoMirroring = false
            conn.isVideoMirrored = mirror
        }
    }

    private func installPreview() {
        guard let web = bridge?.webView else { return }
        if previewView == nil {
            let host: UIView = web.superview ?? web
            let v = PreviewView(frame: host.bounds)
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            v.backgroundColor = .black
            v.previewLayer.videoGravity = .resizeAspectFill
            if web.superview != nil { host.insertSubview(v, belowSubview: web) } else { web.insertSubview(v, at: 0) }
            previewView = v
        }
        previewView?.previewLayer.session = session
        updateRotation()
        applyMirror()
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        UIApplication.shared.isIdleTimerDisabled = true
    }

    @objc func start(_ call: CAPPluginCall) {
        mirror = call.getBool("mirror") ?? true
        Task {
            let videoOK = await AVCaptureDevice.requestAccess(for: .video)
            let audioOK = await AVCaptureDevice.requestAccess(for: .audio)
            guard videoOK, audioOK else {
                call.reject("אין הרשאה למצלמה או למיקרופון. אפשר בהגדרות האייפון > פרומפטר")
                return
            }
            do { try self.configureIfNeeded() } catch {
                call.reject(error.localizedDescription)
                return
            }
            await MainActor.run { self.installPreview() }
            self.queue.async {
                if !self.session.isRunning { self.session.startRunning() }
                DispatchQueue.main.async { self.updateRotation(); self.applyMirror() }
                call.resolve(["width": 1920, "height": 1080, "fps": 30])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
            if self.session.isRunning { self.session.stopRunning() }
            DispatchQueue.main.async {
                self.previewView?.removeFromSuperview()
                self.previewView = nil
                self.rotationStore = nil
                UIApplication.shared.isIdleTimerDisabled = false
                call.resolve()
            }
        }
    }

    @objc func setMirror(_ call: CAPPluginCall) {
        mirror = call.getBool("mirror") ?? true
        DispatchQueue.main.async {
            self.applyMirror()
            call.resolve()
        }
    }

    @objc func startRecording(_ call: CAPPluginCall) {
        queue.async {
            // ריפוי עצמי: אם המצלמה נעצרה (למשל אחרי ניגון סרטון או הפרעה), מפעילים אותה מחדש
            if !self.session.isRunning { self.session.startRunning() }
            guard self.session.isRunning else { call.reject("המצלמה לא פעילה. בדוק שאין שיחה או אפליקציה אחרת שמשתמשת במצלמה"); return }
            if self.movieOutput.isRecording { call.reject("כבר מקליט"); return }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("takes", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            DispatchQueue.main.sync { self.updateRotation() }
            let url = dir.appendingPathComponent("take-\(Int(Date().timeIntervalSince1970 * 1000)).mov")
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
            call.resolve()
        }
    }

    @objc func stopRecording(_ call: CAPPluginCall) {
        queue.async {
            guard self.movieOutput.isRecording else { call.reject("לא מקליט"); return }
            self.stopCall = call
            self.movieOutput.stopRecording()
        }
    }

    public func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                           from connections: [AVCaptureConnection], error: Error?) {
        let call = stopCall
        stopCall = nil
        var ok = true
        if let err = error as NSError? {
            ok = (err.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? false
        }
        if ok {
            let seconds = AVURLAsset(url: outputFileURL).duration.seconds
            call?.resolve(["path": outputFileURL.path, "duration": seconds.isFinite ? seconds : 0])
        } else {
            call?.reject(error?.localizedDescription ?? "ההקלטה נכשלה")
        }
    }

    @objc func saveToPhotos(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("חסר נתיב"); return }
        let url = URL(fileURLWithPath: path)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("אין הרשאה לשמור לגלריה. אפשר בהגדרות האייפון > פרומפטר > תמונות")
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }) { ok, err in
                if ok {
                    try? FileManager.default.removeItem(at: url)
                    call.resolve()
                } else {
                    call.reject(err?.localizedDescription ?? "השמירה נכשלה")
                }
            }
        }
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        if let path = call.getString("path") { try? FileManager.default.removeItem(atPath: path) }
        call.resolve()
    }

    private var takesDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("takes", isDirectory: true)
    }

    @objc func info(_ call: CAPPluginCall) {
        try? FileManager.default.createDirectory(at: takesDir, withIntermediateDirectories: true)
        call.resolve(["dir": takesDir.path])
    }

    // ---------- ייצוא לגלריה: טייק-טייק (עם חיתוך אם יש) או חיבור של הכול לסרטון אחד ----------
    private func trimRange(_ it: [String: Any], _ asset: AVURLAsset) async throws -> (CMTimeRange, Bool) {
        let total = try await asset.load(.duration).seconds
        let ts = max(0, (it["ts"] as? NSNumber)?.doubleValue ?? 0)
        let te = max(0, (it["te"] as? NSNumber)?.doubleValue ?? 0)
        let start = min(ts, max(0, total - 0.1))
        let end = min(total, max(start + 0.1, total - te))
        let r = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                            end: CMTime(seconds: end, preferredTimescale: 600))
        return (r, ts > 0.05 || te > 0.05)
    }

    private func runExport(_ asset: AVAsset, _ range: CMTimeRange?) async throws -> URL {
        guard let ex = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw NSError(domain: "cam", code: 3, userInfo: [NSLocalizedDescriptionKey: "לא ניתן לייצא את הסרטון"])
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString).mov")
        ex.outputURL = out
        ex.outputFileType = .mov
        if let r = range { ex.timeRange = r }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            ex.exportAsynchronously { c.resume() }
        }
        guard ex.status == .completed else {
            throw ex.error ?? NSError(domain: "cam", code: 4, userInfo: [NSLocalizedDescriptionKey: "הייצוא נכשל"])
        }
        return out
    }

    private func buildOne(_ it: [String: Any]) async throws -> URL {
        guard let path = it["path"] as? String else {
            throw NSError(domain: "cam", code: 5, userInfo: [NSLocalizedDescriptionKey: "חסר נתיב"])
        }
        let url = URL(fileURLWithPath: path)
        let asset = AVURLAsset(url: url)
        let (r, trimmed) = try await trimRange(it, asset)
        if !trimmed { return url }  // בלי חיתוך: שומרים את הקובץ המקורי כמו שהוא
        return try await runExport(asset, r)
    }

    private func buildJoined(_ items: [[String: Any]]) async throws -> URL {
        let comp = AVMutableComposition()
        guard let vTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let aTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw NSError(domain: "cam", code: 6, userInfo: [NSLocalizedDescriptionKey: "לא ניתן לחבר"])
        }
        var cursor = CMTime.zero
        var first = true
        for it in items {
            guard let path = it["path"] as? String else { continue }
            let asset = AVURLAsset(url: URL(fileURLWithPath: path))
            let (r, _) = try await trimRange(it, asset)
            if let sv = try await asset.loadTracks(withMediaType: .video).first {
                try vTrack.insertTimeRange(r, of: sv, at: cursor)
                if first { vTrack.preferredTransform = try await sv.load(.preferredTransform); first = false }
            }
            if let sa = try await asset.loadTracks(withMediaType: .audio).first {
                try aTrack.insertTimeRange(r, of: sa, at: cursor)
            }
            cursor = CMTimeAdd(cursor, r.duration)
        }
        return try await runExport(comp, nil)
    }

    private func saveAll(_ urls: [URL]) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                for u in urls { _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: u) }
            }) { ok, err in
                if ok { c.resume() } else {
                    c.resume(throwing: err ?? NSError(domain: "cam", code: 7, userInfo: [NSLocalizedDescriptionKey: "השמירה נכשלה"]))
                }
            }
        }
    }

    @objc func exportToPhotos(_ call: CAPPluginCall) {
        guard let items = call.getArray("items") as? [[String: Any]], !items.isEmpty else {
            call.reject("אין טייקים לשמירה"); return
        }
        let join = call.getBool("join") ?? false
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("אין הרשאה לשמור לגלריה. אפשר בהגדרות האייפון > פרומפטר > תמונות")
                return
            }
            Task {
                do {
                    var outputs: [URL] = []
                    if join { outputs = [try await self.buildJoined(items)] }
                    else { for it in items { outputs.append(try await self.buildOne(it)) } }
                    try await self.saveAll(outputs)
                    let tmp = FileManager.default.temporaryDirectory.path
                    for u in outputs where u.path.hasPrefix(tmp) { try? FileManager.default.removeItem(at: u) }
                    call.resolve(["saved": outputs.count])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
        }
    }
}
