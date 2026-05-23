package io.github.carguo.douyintool

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Lightweight, best-effort update checker.
 *
 * Behaviour:
 *   - Pings api.github.com/repos/CarGuo/douyin-tool/releases/latest at most
 *     once per [CHECK_INTERVAL_MS] (24h by default), persisted via prefs.
 *   - Compares `tag_name` (stripping a leading "v") to BuildConfig.VERSION_NAME
 *     using a tolerant numeric/semver-lite ordering.
 *   - On a newer version found, invokes [onNewVersion] on the UI thread with
 *     a ready-to-show summary so the caller can render a Toast/Snackbar.
 *   - Network failures are silently swallowed — a lot of users sit behind GFW
 *     where api.github.com is unreachable, and we don't want a noisy Toast on
 *     every cold start.
 *
 * The whole thing runs on a single background thread; no coroutines, no
 * lifecycle scope, so it's safe to fire from MainActivity.onCreate without
 * any extra plumbing.
 */
class UpdateChecker(private val context: Context) {

    fun interface OnNewVersion {
        fun onAvailable(latest: String, current: String, releaseUrl: String)
    }

    fun checkAsync(onNewVersion: OnNewVersion) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastCheck = prefs.getLong(KEY_LAST_CHECK, 0L)
        val now = System.currentTimeMillis()
        if (now - lastCheck < CHECK_INTERVAL_MS) {
            Log.d(TAG, "skip update check (last ${(now - lastCheck) / 1000}s ago)")
            return
        }

        Thread({
            try {
                val (latestTag, htmlUrl) = fetchLatestRelease() ?: return@Thread
                prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
                val current = BuildConfig.VERSION_NAME
                if (isNewer(latestTag, current)) {
                    Log.i(TAG, "update available: $latestTag (current=$current)")
                    val main = android.os.Handler(context.mainLooper)
                    main.post { onNewVersion.onAvailable(latestTag, current, htmlUrl) }
                } else {
                    Log.d(TAG, "up to date (latest=$latestTag, current=$current)")
                }
            } catch (t: Throwable) {
                // Silent: user might be behind GFW, on Wi-Fi captive portal,
                // or simply offline. Updating is purely informational.
                Log.d(TAG, "update check failed: ${t.message}")
            }
        }, "update-checker").apply { isDaemon = true }.start()
    }

    private fun fetchLatestRelease(): Pair<String, String>? {
        val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder()
            .url(API_LATEST)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "DouyinToolAndroid/${BuildConfig.VERSION_NAME}")
            .build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                Log.d(TAG, "github API status=${res.code}")
                return null
            }
            val body = res.body?.string().orEmpty()
            if (body.isEmpty()) return null
            val payload = Json { ignoreUnknownKeys = true }.decodeFromString(
                ReleasePayload.serializer(),
                body,
            )
            val tag = payload.tag_name?.trim().orEmpty()
            val url = payload.html_url?.trim().orEmpty().ifEmpty { FALLBACK_URL }
            if (tag.isEmpty()) return null
            return tag to url
        }
    }

    @Serializable
    private data class ReleasePayload(
        val tag_name: String? = null,
        val html_url: String? = null,
    )

    companion object {
        private const val TAG = "UpdateChecker"
        private const val PREFS = "dt-update-check"
        private const val KEY_LAST_CHECK = "last_check_ms"
        private const val CHECK_INTERVAL_MS = 24L * 60L * 60L * 1000L
        private const val API_LATEST = "https://api.github.com/repos/CarGuo/douyin-tool/releases/latest"
        const val FALLBACK_URL = "https://github.com/CarGuo/douyin-tool/releases/latest"

        /**
         * Compare two semver-lite strings. Strips a leading 'v', splits on dots,
         * and parses each segment as an integer (defaulting to 0 on parse error).
         * Tolerates extra trailing segments (e.g. "1.0.0.1" beats "1.0.0").
         */
        fun isNewer(latestRaw: String, currentRaw: String): Boolean {
            val a = parts(latestRaw)
            val b = parts(currentRaw)
            val n = maxOf(a.size, b.size)
            for (i in 0 until n) {
                val x = a.getOrElse(i) { 0 }
                val y = b.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }

        private fun parts(v: String): List<Int> {
            val cleaned = v.trim().removePrefix("v").removePrefix("V")
            // Strip any "-rc1" / "+build" suffix so we only compare numeric parts.
            val core = cleaned.takeWhile { it.isDigit() || it == '.' }
            if (core.isEmpty()) return listOf(0)
            return core.split('.').map { it.toIntOrNull() ?: 0 }
        }

        /** Open the release page in the user's default browser. */
        fun openReleasePage(context: Context, url: String) {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (t: Throwable) {
                Log.w(TAG, "openReleasePage failed", t)
            }
        }
    }
}
