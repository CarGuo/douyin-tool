package io.github.carguo.douyintool.server

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import io.github.carguo.douyintool.douyin.AwemeKind
import io.github.carguo.douyintool.douyin.DouyinClient
import io.github.carguo.douyintool.douyin.DownloadHostAllow
import io.github.carguo.douyintool.douyin.InvalidLinkError
import io.github.carguo.douyintool.douyin.ParseFailedError
import io.github.carguo.douyintool.douyin.ParseService
import io.github.carguo.douyintool.douyin.ParsedAweme
import io.github.carguo.douyintool.douyin.UpstreamError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.ServerSocket
import java.net.URL

class DouyinServer(
    private val assets: AssetManager,
    private val parseService: ParseService = ParseService(),
    private val client: OkHttpClient = DouyinClient.build(15_000),
    port: Int = 0,
) : NanoHTTPD("127.0.0.1", port.takeIf { it > 0 } ?: pickFreePort()) {

    constructor(context: Context) : this(context.assets)

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    companion object {
        private const val TAG = "DouyinServer"
        private const val WEB_ROOT = "web"

        fun pickFreePort(): Int = ServerSocket(0).use { it.localPort }
    }

    val port: Int get() = listeningPort

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        return try {
            when {
                session.method == Method.OPTIONS -> corsPreflight()
                uri == "/api/health" -> handleHealth()
                uri == "/api/parse" && session.method == Method.POST -> handleParse(session)
                uri == "/api/probe" && session.method == Method.GET -> handleProbe(session)
                uri == "/api/download" && session.method == Method.GET -> handleDownload(session)
                uri == "/api/auth/state" -> okJson("""{"ok":true,"authenticated":true,"exp":0}""")
                uri.startsWith("/api/") -> notFound()
                else -> serveStatic(uri)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "unhandled error on $uri", t)
            errorJson(Response.Status.INTERNAL_ERROR, "INTERNAL", t.message ?: "internal error")
        }.also { addCorsHeaders(it) }
    }

    private fun handleHealth(): Response = okJson("""{"ok":true,"ts":${System.currentTimeMillis()}}""")

    private fun handleParse(session: IHTTPSession): Response {
        val body = readBody(session)
        val url: String? = try {
            JSONObject(body).optString("url", "").takeIf { it.isNotEmpty() }
        } catch (_: Throwable) {
            return errorJson(Response.Status.BAD_REQUEST, "BAD_BODY", "invalid json body")
        }
        if (url.isNullOrEmpty()) return errorJson(Response.Status.BAD_REQUEST, "BAD_BODY", "missing url")
        return try {
            val data = parseService.parseFromUserInput(url)
            val payload = buildJsonObject {
                put("ok", true)
                put("data", encodeAweme(data))
                putJsonObject("mirror") {
                    put("enabled", false)
                    put("autoMirror", false)
                }
            }
            okJson(payload.toString())
        } catch (e: InvalidLinkError) {
            errorJson(Response.Status.BAD_REQUEST, e.code, e.message ?: "invalid link")
        } catch (e: ParseFailedError) {
            errorJson(Response.Status.lookup(422) ?: Response.Status.INTERNAL_ERROR, e.code, e.message ?: "parse failed")
        } catch (e: UpstreamError) {
            errorJson(Response.Status.lookup(502) ?: Response.Status.INTERNAL_ERROR, e.code, e.message ?: "upstream failed")
        } catch (e: Throwable) {
            Log.e(TAG, "parse internal", e)
            errorJson(Response.Status.INTERNAL_ERROR, "INTERNAL", "服务器内部错误")
        }
    }

    private fun handleProbe(session: IHTTPSession): Response {
        val target = session.parameters["url"]?.firstOrNull()
            ?: return errorJson(Response.Status.BAD_REQUEST, "BAD", "missing url")
        val parsed = try { URL(target) } catch (_: Throwable) {
            return errorJson(Response.Status.BAD_REQUEST, "BAD", "invalid url")
        }
        if (parsed.protocol != "http" && parsed.protocol != "https") {
            return errorJson(Response.Status.BAD_REQUEST, "BAD", "unsupported protocol")
        }
        if (!DownloadHostAllow.isAllowed(parsed.host)) {
            return errorJson(Response.Status.FORBIDDEN, "BAD", "host not allowed: ${parsed.host}")
        }
        try {
            client.newCall(
                Request.Builder()
                    .url(target)
                    .head()
                    .header("Referer", "https://www.douyin.com/")
                    .build()
            ).execute().use { res ->
                val cl = res.header("Content-Length")?.toLongOrNull()
                if (cl != null && cl > 0) return okJson("""{"ok":true,"size":$cl}""")
            }
        } catch (_: Throwable) {
        }
        try {
            client.newCall(
                Request.Builder()
                    .url(target)
                    .header("Referer", "https://www.douyin.com/")
                    .header("Range", "bytes=0-0")
                    .build()
            ).execute().use { res ->
                val cr = res.header("Content-Range")
                if (cr != null) {
                    val m = Regex("""/(\d+)$""").find(cr)
                    val total = m?.groupValues?.get(1)?.toLongOrNull()
                    if (total != null && total > 0) return okJson("""{"ok":true,"size":$total}""")
                }
                val cl = res.header("Content-Length")?.toLongOrNull()
                if (cl != null && cl > 0) return okJson("""{"ok":true,"size":$cl}""")
            }
        } catch (_: Throwable) {
        }
        return okJson("""{"ok":true,"size":0}""")
    }

    private fun handleDownload(session: IHTTPSession): Response {
        val target = session.parameters["url"]?.firstOrNull()
            ?: return errorJson(Response.Status.BAD_REQUEST, "BAD", "missing url")
        val parsed = try { URL(target) } catch (_: Throwable) {
            return errorJson(Response.Status.BAD_REQUEST, "BAD", "invalid url")
        }
        if (parsed.protocol != "http" && parsed.protocol != "https") {
            return errorJson(Response.Status.BAD_REQUEST, "BAD", "unsupported protocol")
        }
        if (!DownloadHostAllow.isAllowed(parsed.host)) {
            return errorJson(Response.Status.FORBIDDEN, "BAD", "host not allowed: ${parsed.host}")
        }
        val inline = session.parameters["inline"]?.firstOrNull() == "1"
        val filenameRaw = session.parameters["filename"]?.firstOrNull() ?: "douyin-download"
        val safeFilename = filenameRaw.replace(Regex("""[^\w.\-]+"""), "_")

        val rangeHeader = session.headers["range"]

        val reqBuilder = Request.Builder()
            .url(target)
            .header("Referer", "https://www.douyin.com/")
        if (!rangeHeader.isNullOrEmpty()) reqBuilder.header("Range", rangeHeader)

        val upstream = try {
            client.newCall(reqBuilder.build()).execute()
        } catch (e: Throwable) {
            Log.w(TAG, "download upstream error", e)
            return errorJson(Response.Status.lookup(502) ?: Response.Status.INTERNAL_ERROR, "BAD", "下载失败")
        }
        if (!upstream.isSuccessful && upstream.code != 206) {
            upstream.close()
            return errorJson(Response.Status.lookup(502) ?: Response.Status.INTERNAL_ERROR, "BAD", "上游 ${upstream.code}")
        }
        val mime = upstream.header("Content-Type") ?: "application/octet-stream"
        val len = upstream.header("Content-Length")?.toLongOrNull() ?: -1L
        val cr = upstream.header("Content-Range")
        val ar = upstream.header("Accept-Ranges") ?: "bytes"
        val status: Response.Status = if (upstream.code == 206) Response.Status.PARTIAL_CONTENT else Response.Status.OK

        val body = upstream.body ?: run {
            upstream.close()
            return errorJson(Response.Status.lookup(502) ?: Response.Status.INTERNAL_ERROR, "BAD", "no body")
        }
        val stream: InputStream = body.byteStream()

        val resp = if (len >= 0)
            newFixedLengthResponse(status, mime, stream, len)
        else
            newChunkedResponse(status, mime, stream)
        if (cr != null) resp.addHeader("Content-Range", cr)
        resp.addHeader("Accept-Ranges", ar)
        if (inline) {
            resp.addHeader("Content-Disposition", "inline")
            resp.addHeader("Cache-Control", "private, max-age=300")
        } else {
            resp.addHeader("Content-Disposition", """attachment; filename="$safeFilename"""")
        }
        return resp
    }

    private fun serveStatic(rawUri: String): Response {
        val cleanPath = rawUri.substringBefore('?').let {
            if (it == "/" || it.isEmpty()) "/index.html" else it
        }
        val rel = cleanPath.removePrefix("/")
        if (rel.contains("..")) return notFound()

        val assetPath = "$WEB_ROOT/$rel"
        val isIndex = rel.endsWith("index.html")

        if (isIndex) {
            val html = try {
                assets.open(assetPath).use { it.readBytes().toString(Charsets.UTF_8) }
            } catch (_: IOException) {
                return notFound()
            }
            return buildHtmlResponse(injectAndroidBypass(html))
        }

        val stream: InputStream = try {
            assets.open(assetPath)
        } catch (_: IOException) {
            return try {
                val fallback = assets.open("$WEB_ROOT/index.html").use { it.readBytes().toString(Charsets.UTF_8) }
                buildHtmlResponse(injectAndroidBypass(fallback))
            } catch (_: IOException) {
                notFound()
            }
        }
        val mime = guessMime(rel)
        return buildAssetResponse(stream, mime)
    }

    /**
     * The PWA's PinGate component checks localStorage["dy.gate.exp"] before
     * rendering its keypad. On Android (loopback-only), a PIN is meaningless,
     * so we pre-seed that storage hint to a far-future expiry the very first
     * tick after the document parses but before React mounts. The web build
     * itself remains untouched — production deployments still gate on PIN.
     */
    private fun injectAndroidBypass(html: String): String {
        val bootstrap = """<script>(function(){try{
            var k='dy.gate.exp';
            var now=Date.now();
            var far=now+365*24*60*60*1000;
            var cur=parseInt(localStorage.getItem(k)||'0',10);
            if(!cur||cur<now){localStorage.setItem(k,String(far));}
        }catch(e){}})();</script>"""
        val marker = "</head>"
        val idx = html.indexOf(marker)
        return if (idx >= 0) html.substring(0, idx) + bootstrap + html.substring(idx) else bootstrap + html
    }

    private fun buildHtmlResponse(html: String): Response {
        val r = newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", html)
        r.addHeader("Cache-Control", "no-store")
        return r
    }

    private fun buildAssetResponse(stream: InputStream, mime: String): Response {
        val r = newChunkedResponse(Response.Status.OK, mime, stream)
        r.addHeader("Cache-Control", "public, max-age=300")
        return r
    }

    private fun guessMime(path: String): String {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".html") -> "text/html; charset=utf-8"
            lower.endsWith(".js") || lower.endsWith(".mjs") -> "application/javascript; charset=utf-8"
            lower.endsWith(".css") -> "text/css; charset=utf-8"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".ico") -> "image/x-icon"
            lower.endsWith(".webmanifest") || lower.endsWith(".json") ->
                "application/manifest+json; charset=utf-8"
            lower.endsWith(".woff2") -> "font/woff2"
            lower.endsWith(".woff") -> "font/woff"
            lower.endsWith(".ttf") -> "font/ttf"
            lower.endsWith(".map") -> "application/json"
            else -> "application/octet-stream"
        }
    }

    private fun encodeAweme(p: ParsedAweme): JsonElement = buildJsonObject {
        put("kind", when (p.kind) {
            AwemeKind.VIDEO -> "video"
            AwemeKind.IMAGE -> "image"
            AwemeKind.UNKNOWN -> "unknown"
        })
        put("awemeId", p.awemeId)
        put("desc", p.desc)
        putJsonObject("author") {
            put("nickname", p.author.nickname)
            p.author.uid?.let { put("uid", it) }
            p.author.avatar?.let { put("avatar", it) }
        }
        p.cover?.let { put("cover", it) }
        p.video?.let { v ->
            putJsonObject("video") {
                put("playUrl", v.playUrl)
                put("playUrlNoWatermark", v.playUrlNoWatermark)
                v.duration?.let { put("duration", it) }
            }
        }
        p.images?.let { list ->
            putJsonArray("images") {
                list.forEach { img ->
                    addJsonObject {
                        put("url", img.url)
                        img.width?.let { put("width", it) }
                        img.height?.let { put("height", it) }
                    }
                }
            }
        }
        p.music?.let { m ->
            putJsonObject("music") {
                m.title?.let { put("title", it) }
                m.author?.let { put("author", it) }
                m.playUrl?.let { put("playUrl", it) }
            }
        }
    }

    private fun readBody(session: IHTTPSession): String {
        val files = HashMap<String, String>()
        return try {
            session.parseBody(files)
            files["postData"] ?: session.parameters["postData"]?.firstOrNull() ?: ""
        } catch (_: Throwable) {
            ""
        }
    }

    private fun okJson(payload: String): Response {
        return newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", payload)
    }

    private fun errorJson(status: Response.Status, code: String, msg: String): Response {
        val esc = msg.replace("\\", "\\\\").replace("\"", "\\\"")
        val payload = """{"ok":false,"code":"$code","message":"$esc"}"""
        return newFixedLengthResponse(status, "application/json; charset=utf-8", payload)
    }

    private fun notFound(): Response =
        newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json; charset=utf-8",
            """{"ok":false,"code":"NOT_FOUND","message":"not found"}""")

    private fun corsPreflight(): Response = newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", "")

    private fun addCorsHeaders(r: Response) {
        r.addHeader("Access-Control-Allow-Origin", "*")
        r.addHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        r.addHeader("Access-Control-Allow-Headers", "Content-Type")
    }
}
