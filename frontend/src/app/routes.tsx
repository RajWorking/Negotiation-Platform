import { createBrowserRouter } from "react-router";
import { SetupScreen } from "./components/setup-screen";
import { LiveSimulation } from "./components/live-simulation";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: SetupScreen,
  },
  {
    path: "/simulation",
    Component: LiveSimulation,
  },
]);
