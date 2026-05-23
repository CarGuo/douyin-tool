package io.github.carguo.douyintool.douyin

/**
 * Mirror of the regex allow-list in packages/server/src/app.ts (incl. Bug A fix).
 */
object DownloadHostAllow {

    private val PATTERNS: List<Regex> = listOf(
        Regex("""\.douyinpic\.com$"""),
        Regex("""\.douyinvod\.com$"""),
        Regex("""\.bytedance\.com$"""),
        Regex("""\.byteimg\.com$"""),
        Regex("""\.amemv\.com$"""),
        Regex("""\.iesdouyin\.com$"""),
        Regex("""\.douyincdn\.com$"""),
        Regex("""(^|\.)snssdk\.com$"""),
        Regex("""(^|\.)aweme\.snssdk\.com$"""),
        Regex("""\.zjcdn\.com$"""),
        Regex("""\.bytecdn\.cn$"""),
        Regex("""\.pstatp\.com$"""),
    )

    fun isAllowed(host: String): Boolean {
        if (UrlExtract.isAllowedShareHost(host)) return true
        return PATTERNS.any { it.containsMatchIn(host) }
    }
}
