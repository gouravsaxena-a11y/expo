/// <reference types="jest-expo/rsc/expect" />

// Imported from `TabsClient`, not the `Tabs` entry point. On native the entry cannot be evaluated
// on the server at all: it re-exports `../react-navigation/bottom-tabs`, whose `TransitionSpecs`
// module calls `Easing.in(...)` at module scope. That is a pre-existing limitation of the entry
// point, not of this navigator.
import Tabs from '../TabsClient';

it(`renders to RSC`, async () => {
  const jsx = <Tabs.Screen options={{ title: '...' }} />;

  await expect(jsx).toMatchFlightSnapshot();
});
