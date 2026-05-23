package io.github.carguo.douyintool.douyin

import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

class InvalidLinkError(msg: String) : RuntimeException(msg) { val code = "INVALID_LINK" }
class UpstreamError(msg: String, cause: Throwable? = null) : RuntimeException(msg, cause) {
    val code = "UPSTREAM"
}
class ParseFailedError(msg: String) : RuntimeException(msg) { val code = "PARSE_FAILED" }

class ParseService(
    private val client: OkHttpClient = DouyinClient.build(),
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true },
) {
    fun parseFromUserInput(input: String): ParsedAweme {
        val url = UrlExtract.extractShareUrl(input)
            ?: throw InvalidLinkError("未在输入中识别到有效的抖音链接")
        val longUrl: String = try {
            DouyinClient.resolveShareUrl(client, url)
        } catch (e: Throwable) {
            throw UpstreamError("解析短链跳转失败", e)
        }
        val html: String = try {
            DouyinClient.fetchSharePage(client, longUrl)
        } catch (e: Throwable) {
            throw UpstreamError("抓取分享页失败", e)
        }
        return DouyinParser.parseHtml(html, json)
            ?: throw ParseFailedError("页面结构变化，未能解析出作品数据")
    }
}
