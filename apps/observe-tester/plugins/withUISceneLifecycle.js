// Adopts the UIKit scene-based life cycle, which the iOS 26+ SDK requires: apps
// without a UIApplicationSceneManifest are stopped at launch with
// "UIScene life cycle is required for apps built with this SDK" (Apple TN3187).
//
// React Native 0.86 has no UIWindowSceneDelegate support of its own — RCTAppDelegate
// still builds the UIWindow in application(_:didFinishLaunchingWithOptions:) — so this
// plugin moves window creation into a scene delegate and leaves the AppDelegate to own
// process-level events. Expo modules hook the app life cycle through
// ExpoAppDelegate's UIApplicationDelegate methods, so the scene delegate forwards the
// callbacks UIKit reroutes away from the AppDelegate; without that, deep links and
// universal links stop reaching expo-linking and expo-router.
//
// Remove this once expo/react-native adopt the scene life cycle upstream
// (tracked in https://github.com/expo/expo/issues/46664).
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

// UIKit instantiates this from UISceneDelegateClassName and drives every UI-facing
// event through it. The window must be built in scene(_:willConnectTo:) — by the time
// it runs, didFinishLaunchingWithOptions has already returned, so creating the window
// there would leave the app with no visible UI.
const SCENE_DELEGATE_SOURCE = `
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    let window = UIWindow(windowScene: windowScene)

    self.window = window
    // Keep the AppDelegate's window in sync: parts of React Native and some Expo
    // modules still read it to find the root view controller.
    appDelegate.window = window

    appDelegate.startReactNative(in: window, launchOptions: nil)

    // Deep links that cold-start the app arrive here rather than through
    // application(_:open:options:), which UIKit no longer calls under scenes.
    if let urlContext = connectionOptions.urlContexts.first {
      _ = appDelegate.application(
        UIApplication.shared,
        open: urlContext.url,
        options: [:])
    }
    for userActivity in connectionOptions.userActivities {
      _ = appDelegate.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in })
    }
  }

  // Warm-start deep links. Forwarded to the AppDelegate so expo-linking and any
  // ExpoAppDelegateSubscriber keep observing a single code path.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    for urlContext in URLContexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: urlContext.url,
        options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    _ = appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }

  // UIKit sends the foreground/background transitions to the scene delegate now.
  // ExpoAppDelegate's subscriber manager still expects the UIApplication variants,
  // so re-dispatch them; expo-app-metrics session tracking depends on these.
  func sceneDidBecomeActive(_ scene: UIScene) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    appDelegate.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    appDelegate.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    appDelegate.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    appDelegate.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;

// The generated AppDelegate creates the window and starts React Native inline. Split
// that into a method the scene delegate can call, so the two stay in one place.
const START_REACT_NATIVE_METHOD = `
  func startReactNative(in window: UIWindow, launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }
`;

function withSceneInfoPlist(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneClassName: 'UIWindowScene',
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return config;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    if (contents.includes('class SceneDelegate')) {
      return config;
    }

    // Drop the window setup from didFinishLaunchingWithOptions — under the scene life
    // cycle UIKit owns window creation, and a window made here never becomes visible.
    const windowSetup =
      /\n#if os\(iOS\) \|\| os\(tvOS\)\s*\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif\n/;
    if (!windowSetup.test(contents)) {
      throw new Error(
        'withUISceneLifecycle could not find the window setup block in AppDelegate.swift. ' +
          'The prebuild template probably changed — update the plugin to match, or drop it ' +
          'if expo now adopts the scene life cycle itself.'
      );
    }
    contents = contents.replace(windowSetup, '');

    // The factory/delegate construction moved into startReactNative(in:launchOptions:).
    const factorySetup =
      /\s*let delegate = ReactNativeDelegate\(\)\n\s*let factory = ExpoReactNativeFactory\(delegate: delegate\)\n\s*delegate\.dependencyProvider = RCTAppDependencyProvider\(\)\n\n\s*reactNativeDelegate = delegate\n\s*reactNativeFactory = factory\n/;
    if (!factorySetup.test(contents)) {
      throw new Error(
        'withUISceneLifecycle could not find the React Native factory setup in AppDelegate.swift. ' +
          'The prebuild template probably changed — update the plugin to match.'
      );
    }
    contents = contents.replace(factorySetup, '');

    // Add startReactNative(in:launchOptions:) as the last member of the AppDelegate,
    // then append the scene delegate at file scope.
    const appDelegateEnd = contents.lastIndexOf('}\n\nclass ReactNativeDelegate');
    if (appDelegateEnd === -1) {
      throw new Error(
        'withUISceneLifecycle could not find the end of the AppDelegate class in AppDelegate.swift. ' +
          'The prebuild template probably changed — update the plugin to match.'
      );
    }
    contents =
      contents.slice(0, appDelegateEnd) +
      START_REACT_NATIVE_METHOD +
      contents.slice(appDelegateEnd) +
      SCENE_DELEGATE_SOURCE;

    config.modResults.contents = contents;
    return config;
  });
}

const withUISceneLifecycle = (config) => withSceneAppDelegate(withSceneInfoPlist(config));

module.exports = withUISceneLifecycle;
