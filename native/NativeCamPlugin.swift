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
    ]

    private let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "teleprompter.camera")
    private var previewView: PreviewView?
    private var configured = false
    private var mirror = true
    private var stopCall: CAPPluginCall?

    private func setPortrait(_ conn: AVCaptureConnection) {
        if #available(iOS 17.0, *) {
            if conn.isVideoRotationAngleSupported(90) { conn.videoRotationAngle = 90 }
        } else if conn.isVideoOrientationSupported {
            conn.videoOrientation = .portrait
        }
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
        if let conn = previewView?.previewLayer.connection { setPortrait(conn) }
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
            guard self.session.isRunning else { call.reject("המצלמה לא פעילה"); return }
            if self.movieOutput.isRecording { call.reject("כבר מקליט"); return }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("takes", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
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
}
