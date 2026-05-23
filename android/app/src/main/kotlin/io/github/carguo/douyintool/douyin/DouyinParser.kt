package io.github.carguo.douyintool.douyin

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

enum class AwemeKind { VIDEO, IMAGE, UNKNOWN }

data class ParsedAuthor(val nickname: String, val uid: String? = null, val avatar: String? = null)
data class ParsedVideo(val playUrl: String, val playUrlNoWatermark: String, val duration: Int? = null)
data class ParsedImage(val url: String, val width: Int? = null, val height: Int? = null)
data class ParsedMusic(val title: String? = null, val author: String? = null, val playUrl: String? = null)

data class ParsedAweme(
    val kind: AwemeKind,
    val awemeId: String,
    val desc: String,
    val author: ParsedAuthor,
    val cover: String? = null,
    val video: ParsedVideo? = null,
    val images: List<ParsedImage>? = null,
    val music: ParsedMusic? = null,
)

object DouyinParser {

    private val ROUTER_DATA_RE = Regex("""window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*</script>""")

    fun findRouterDataJson(html: String): String? = ROUTER_DATA_RE.find(html)?.groupValues?.get(1)

    fun toNoWatermark(url: String): String =
        url.replace("/playwm/", "/play/").replace("playwm", "play")

    private fun JsonObject.strOrNull(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { (this[key] as? JsonPrimitive)?.isString != false }

    private fun JsonObject.intOrNull(key: String): Int? =
        (this[key] as? JsonPrimitive)?.intOrNull

    private fun pickFirstUrl(container: JsonElement?): String? {
        val obj = container as? JsonObject ?: return null
        val list = obj["url_list"] as? JsonArray ?: return null
        for (item in list) {
            val s = (item as? JsonPrimitive)?.contentOrNull
            if (!s.isNullOrEmpty()) return s
        }
        return null
    }

    /**
     * Mirror of the Node implementation: walk the deserialized _ROUTER_DATA
     * looking for the first object that either *is* an aweme detail (has
     * aweme_id|awemeId AND video|images|music) or that has an `aweme_detail`
     * child whose recursion should be prioritized.
     */
    fun findAwemeDetail(routerData: JsonElement?): JsonObject? {
        if (routerData == null) return null
        val stack = ArrayDeque<JsonElement>()
        stack.addLast(routerData)
        val seen = HashSet<Int>()
        while (stack.isNotEmpty()) {
            val cur = stack.removeLast()
            if (cur !is JsonObject) {
                if (cur is JsonArray) {
                    for (v in cur) stack.addLast(v)
                }
                continue
            }
            val id = System.identityHashCode(cur)
            if (!seen.add(id)) continue

            val hasId = cur.containsKey("aweme_id") || cur.containsKey("awemeId")
            val hasMedia = cur.containsKey("video") || cur.containsKey("images") || cur.containsKey("music")
            if (hasId && hasMedia) return cur

            val ad = cur["aweme_detail"]
            if (ad is JsonObject) stack.addLast(ad)

            for ((_, v) in cur) {
                if (v is JsonObject || v is JsonArray) stack.addLast(v)
            }
        }
        return null
    }

    fun normalizeAweme(raw: JsonObject): ParsedAweme {
        val awemeId =
            (raw["aweme_id"] as? JsonPrimitive)?.contentOrNull
                ?: (raw["awemeId"] as? JsonPrimitive)?.contentOrNull
                ?: ""
        val desc = (raw["desc"] as? JsonPrimitive)?.contentOrNull ?: ""

        val videoObj = raw["video"] as? JsonObject
        val cover = pickFirstUrl(videoObj?.get("cover"))

        val authorObj = raw["author"] as? JsonObject
        val author = ParsedAuthor(
            nickname = (authorObj?.get("nickname") as? JsonPrimitive)?.contentOrNull ?: "",
            uid = (authorObj?.get("uid") as? JsonPrimitive)?.contentOrNull,
            avatar = pickFirstUrl(authorObj?.get("avatar_thumb")),
        )

        val musicObj = raw["music"] as? JsonObject
        val music = if (musicObj != null) ParsedMusic(
            title = (musicObj["title"] as? JsonPrimitive)?.contentOrNull,
            author = (musicObj["author"] as? JsonPrimitive)?.contentOrNull,
            playUrl = pickFirstUrl(musicObj["play_url"]),
        ) else null

        val imagesArr = raw["images"] as? JsonArray
        if (imagesArr != null && imagesArr.isNotEmpty()) {
            val images = imagesArr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val url = pickFirstUrl(o) ?: return@mapNotNull null
                ParsedImage(
                    url = url,
                    width = (o["width"] as? JsonPrimitive)?.intOrNull,
                    height = (o["height"] as? JsonPrimitive)?.intOrNull,
                )
            }.filter { it.url.isNotEmpty() }
            return ParsedAweme(
                kind = AwemeKind.IMAGE,
                awemeId = awemeId,
                desc = desc,
                author = author,
                cover = cover,
                images = images,
                music = music,
            )
        }

        val playRaw = pickFirstUrl(videoObj?.get("play_addr"))
        if (playRaw != null) {
            return ParsedAweme(
                kind = AwemeKind.VIDEO,
                awemeId = awemeId,
                desc = desc,
                author = author,
                cover = cover,
                video = ParsedVideo(
                    playUrl = playRaw,
                    playUrlNoWatermark = toNoWatermark(playRaw),
                    duration = (videoObj?.get("duration") as? JsonPrimitive)?.intOrNull,
                ),
                music = music,
            )
        }

        return ParsedAweme(
            kind = AwemeKind.UNKNOWN,
            awemeId = awemeId,
            desc = desc,
            author = author,
            cover = cover,
            music = music,
        )
    }

    fun parseHtml(html: String, json: kotlinx.serialization.json.Json): ParsedAweme? {
        val raw = findRouterDataJson(html) ?: return null
        val data = try {
            json.parseToJsonElement(raw)
        } catch (_: Throwable) {
            return null
        }
        val detail = findAwemeDetail(data) ?: return null
        return normalizeAweme(detail)
    }
}
