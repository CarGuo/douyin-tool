import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/* ──────────────────────────────────────────────────────────────────────────
 * syncWebAssets
 *   1. cd ../../  (repo root)
 *   2. ./bin/npm install --workspace @douyin-tool/web   (idempotent)
 *   3. ./bin/npm run -w @douyin-tool/web build           (vite -> packages/web/dist/)
 *   4. copy packages/web/dist/  ->  app/src/main/assets/web/
 *
 * Hooked into preBuild so `./gradlew :app:assembleDebug` from a fresh clone
 * just works. CI (.github/workflows/android-release.yml) runs the same chain.
 * ────────────────────────────────────────────────────────────────────────── */
val repoRoot = rootProject.projectDir.parentFile  // android/.. == repo root
val webDist = file("${repoRoot}/packages/web/dist")
val webAssetsOut = file("src/main/assets/web")

val isWindows = System.getProperty("os.name").lowercase().contains("win")
val npmCmd = if (isWindows) "${repoRoot}/bin/npm.cmd" else "${repoRoot}/bin/npm"

val installWeb by tasks.registering(Exec::class) {
    workingDir = repoRoot
    commandLine(npmCmd, "install", "--workspace", "@douyin-tool/web", "--ignore-scripts")
    // Skip if node_modules already exists; npm itself is idempotent but this
    // saves several seconds on warm builds.
    onlyIf { !file("${repoRoot}/node_modules/@douyin-tool").exists() }
}

val buildWeb by tasks.registering(Exec::class) {
    dependsOn(installWeb)
    workingDir = repoRoot
    commandLine(npmCmd, "run", "-w", "@douyin-tool/web", "build")
    inputs.dir("${repoRoot}/packages/web/src")
    inputs.file("${repoRoot}/packages/web/index.html")
    inputs.file("${repoRoot}/packages/web/vite.config.ts")
    inputs.file("${repoRoot}/packages/web/package.json")
    outputs.dir(webDist)
}

val syncWebAssets by tasks.registering(Copy::class) {
    dependsOn(buildWeb)
    from(webDist)
    into(webAssetsOut)
    doFirst {
        webAssetsOut.deleteRecursively()
        webAssetsOut.mkdirs()
    }
}

android {
    namespace = "io.github.carguo.douyintool"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.carguo.douyintool"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            storeFile = file("${repoRoot}/android/release.jks")
            storePassword = "123456"
            keyAlias = "debug"
            keyPassword = "123456"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }
}

// Make sure Vite is built and copied before AGP packs assets.
tasks.named("preBuild").configure { dependsOn(syncWebAssets) }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")

    testImplementation("junit:junit:4.13.2")
}
