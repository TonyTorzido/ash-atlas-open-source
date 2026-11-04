// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "CapacitorFirebaseCrashlytics", path: "../../../node_modules/.pnpm/@capacitor-firebase+crashlytics@8.5.2_@capacitor+core@8.5.0/node_modules/@capacitor-firebase/crashlytics"),
        .package(name: "CapacitorApp", path: "../../../node_modules/.pnpm/@capacitor+app@8.1.1_@capacitor+core@8.5.0/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../node_modules/.pnpm/@capacitor+browser@8.0.4_@capacitor+core@8.5.0/node_modules/@capacitor/browser"),
        .package(name: "CapacitorFilesystem", path: "../../../node_modules/.pnpm/@capacitor+filesystem@8.1.4_@capacitor+core@8.5.0/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorGeolocation", path: "../../../node_modules/.pnpm/@capacitor+geolocation@8.2.2_@capacitor+core@8.5.0/node_modules/@capacitor/geolocation"),
        .package(name: "CapacitorHaptics", path: "../../../node_modules/.pnpm/@capacitor+haptics@8.0.2_@capacitor+core@8.5.0/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorPushNotifications", path: "../../../node_modules/.pnpm/@capacitor+push-notifications@8.1.2_@capacitor+core@8.5.0/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../node_modules/.pnpm/@capacitor+share@8.0.3_@capacitor+core@8.5.0/node_modules/@capacitor/share"),
        .package(name: "CapawesomeCapacitorAppReview", path: "../../../node_modules/.pnpm/@capawesome+capacitor-app-review@8.0.2_@capacitor+core@8.5.0/node_modules/@capawesome/capacitor-app-review"),
        .package(name: "CapawesomeCapacitorLiveUpdate", path: "../../../node_modules/.pnpm/@capawesome+capacitor-live-_a2a66aa04f5b5d209f0b7b6f9dee00a2/node_modules/@capawesome/capacitor-live-update")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorFirebaseCrashlytics", package: "CapacitorFirebaseCrashlytics"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorGeolocation", package: "CapacitorGeolocation"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapawesomeCapacitorAppReview", package: "CapawesomeCapacitorAppReview"),
                .product(name: "CapawesomeCapacitorLiveUpdate", package: "CapawesomeCapacitorLiveUpdate")
            ]
        )
    ]
)
