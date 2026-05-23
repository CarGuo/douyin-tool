package io.github.carguo.douyintool.douyin

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Equivalent of packages/server/src/lib/extractUrl.ts
 */
object UrlExtract {
    private val URL_REGEX = Regex("""(https?://[^\s\u4e00-\u9fa5]+)""")

    private val ALLOWED_SHARE_HOSTS = setOf(
        "v.douyin.com",
        "www.douyin.com",
        "douyin.com",
        "www.iesdouyin.com",
        "iesdouyin.com",
    )

    fun extractShareUrl(input: String?): String? {
        if (input.isNullOrEmpty()) return null
        for (m in URL_REGEX.findAll(input)) {
            val raw = m.value
            val parsed = raw.toHttpUrlOrNull() ?: continue
            if (ALLOWED_SHARE_HOSTS.contains(parsed.host)) return parsed.toString()
        }
        return null
    }

    fun isAllowedShareHost(host: String): Boolean = ALLOWED_SHARE_HOSTS.contains(host)
}
