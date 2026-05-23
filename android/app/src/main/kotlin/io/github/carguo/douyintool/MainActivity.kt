package io.github.carguo.douyintool

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import fi.iki.elonen.NanoHTTPD
import io.github.carguo.douyintool.server.DouyinServer
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var server: DouyinServer? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val baseUrl = startServerOrFail() ?: run {
            Toast.makeText(this, "本地服务启动失败", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.userAgentString = settings.userAgentString + " DouyinToolAndroid/" + BuildConfig.VERSION_NAME
            webViewClient = WebViewClient()
            addJavascriptInterface(BlobBridge(), "AndroidBlobBridge")
            setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
                handleDownload(url, userAgent, contentDisposition, mimetype)
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        setContentView(webView)

        webView.loadUrl(baseUrl)
        Log.i(TAG, "WebView loaded $baseUrl")

        // Best-effort: fire a background update check. Throttled to once per
        // 24h via SharedPreferences. Users behind GFW just won't see anything;
        // failures are silent on purpose.
        UpdateChecker(this).checkAsync { latest, current, releaseUrl ->
            showUpdateDialog(latest, current, releaseUrl)
        }
    }

    private fun showUpdateDialog(latest: String, current: String, releaseUrl: String) {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle("发现新版本 $latest")
            .setMessage("当前版本 $current\n\n是否前往 GitHub Releases 查看更新？")
            .setPositiveButton("立即查看") { _, _ ->
                UpdateChecker.openReleasePage(this, releaseUrl)
            }
            .setNegativeButton("暂不更新", null)
            .setCancelable(true)
            .show()
    }

    private fun startServerOrFail(): String? {
        return try {
            val s = DouyinServer(this)
            s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = s
            "http://127.0.0.1:${s.port}/"
        } catch (t: Throwable) {
            Log.e(TAG, "server start failed", t)
            null
        }
    }

    private fun handleDownload(url: String, userAgent: String?, contentDisposition: String?, mimetype: String?) {
        if (url.startsWith("blob:")) {
            val filename = URLUtil.guessFileName(url, contentDisposition, mimetype)
            Toast.makeText(this, "正在准备下载…", Toast.LENGTH_SHORT).show()
            webView.evaluateJavascript(buildBlobReaderScript(url, filename, mimetype ?: "application/octet-stream"), null)
            return
        }
        try {
            val request = DownloadManager.Request(Uri.parse(url))
            val filename = URLUtil.guessFileName(url, contentDisposition, mimetype)
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            request.setMimeType(mimetype ?: "application/octet-stream")
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent)
            request.addRequestHeader("Referer", "http://127.0.0.1/")
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.enqueue(request)
            Toast.makeText(this, "已加入系统下载：$filename", Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            Log.e(TAG, "download enqueue failed", t)
            Toast.makeText(this, "下载失败：${t.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Build a JS snippet that:
     *   1. Fetches the blob URL (the same-origin browser already holds the bytes).
     *   2. Reads it as a base64 dataURL via FileReader.
     *   3. Hands the base64 payload back to Native through AndroidBlobBridge.
     */
    private fun buildBlobReaderScript(blobUrl: String, filename: String, mime: String): String {
        val safeBlob = blobUrl.replace("\\", "\\\\").replace("'", "\\'")
        val safeName = filename.replace("\\", "\\\\").replace("'", "\\'")
        val safeMime = mime.replace("\\", "\\\\").replace("'", "\\'")
        return """
            (function(){
              try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', '$safeBlob', true);
                xhr.responseType = 'blob';
                xhr.onload = function(){
                  if (xhr.status >= 200 && xhr.status < 300) {
                    var fr = new FileReader();
                    fr.onload = function(){
                      var dataUrl = fr.result || '';
                      var idx = String(dataUrl).indexOf(',');
                      var b64 = idx >= 0 ? String(dataUrl).substring(idx + 1) : '';
                      AndroidBlobBridge.saveBase64(b64, '$safeName', '$safeMime');
                    };
                    fr.onerror = function(e){ AndroidBlobBridge.reportError('FileReader: ' + (e && e.message ? e.message : 'unknown')); };
                    fr.readAsDataURL(xhr.response);
                  } else {
                    AndroidBlobBridge.reportError('xhr status ' + xhr.status);
                  }
                };
                xhr.onerror = function(){ AndroidBlobBridge.reportError('xhr network error'); };
                xhr.send();
              } catch (e) {
                AndroidBlobBridge.reportError('exception: ' + (e && e.message ? e.message : String(e)));
              }
            })();
        """.trimIndent()
    }

    override fun onDestroy() {
        try { webView.destroy() } catch (_: Throwable) {}
        try { server?.stop() } catch (_: Throwable) {}
        server = null
        super.onDestroy()
    }

    /**
     * JS-callable bridge. saveBase64() is invoked from inside the WebView when
     * the blob has been fully read into a base64 string. We decode and write it
     * to the public Downloads/ collection. On Android Q+ we use MediaStore so
     * we don't need WRITE_EXTERNAL_STORAGE; on lower we fall back to legacy.
     */
    inner class BlobBridge {
        @JavascriptInterface
        fun saveBase64(base64: String, filenameRaw: String, mime: String) {
            try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val filename = sanitizeFilename(filenameRaw)
                val savedPath = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveViaMediaStore(filename, mime, bytes)
                } else {
                    saveViaLegacyDownloads(filename, bytes)
                }
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "已保存到下载：$savedPath", Toast.LENGTH_LONG).show()
                }
                Log.i(TAG, "blob saved -> $savedPath (${bytes.size} bytes)")
            } catch (t: Throwable) {
                Log.e(TAG, "saveBase64 failed", t)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "保存失败：${t.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        @JavascriptInterface
        fun reportError(message: String) {
            Log.w(TAG, "blob bridge error: $message")
            runOnUiThread {
                Toast.makeText(this@MainActivity, "下载失败：$message", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun sanitizeFilename(name: String): String {
        val cleaned = name.replace(Regex("""[\\/:*?"<>|\u0000-\u001F]"""), "_").trim()
        return if (cleaned.isEmpty()) "douyin-${System.currentTimeMillis()}.bin" else cleaned
    }

    private fun saveViaMediaStore(filename: String, mime: String, bytes: ByteArray): String {
        val resolver = contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DouyinTool")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val item = resolver.insert(collection, values) ?: error("insert MediaStore failed")
        resolver.openOutputStream(item).use { os ->
            requireNotNull(os) { "openOutputStream returned null" }
            os.write(bytes)
            os.flush()
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(item, values, null, null)
        return "Downloads/DouyinTool/$filename"
    }

    @Suppress("DEPRECATION")
    private fun saveViaLegacyDownloads(filename: String, bytes: ByteArray): String {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "DouyinTool")
        if (!dir.exists()) dir.mkdirs()
        val out = File(dir, filename)
        FileOutputStream(out).use { it.write(bytes); it.flush() }
        return out.absolutePath
    }

    companion object {
        private const val TAG = "DouyinTool"
    }
}
