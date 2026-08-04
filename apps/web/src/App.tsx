import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Layout, RequireAuth } from "./components/Layout.js";
import { NewAccountDrawer } from "./components/NewAccountDrawer.js";
import { NewIncomeDrawer } from "./components/NewIncomeDrawer.js";
import { NewPaymentDrawer } from "./components/NewPaymentDrawer.js";
import { PrivacyProvider } from "./contexts/PrivacyContext.js";
import { QuickAddProvider } from "./contexts/QuickAddContext.js";
import { ThemeProvider } from "./contexts/ThemeContext.js";
import { AccountPage } from "./pages/AccountPage.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.js";
import { HouseholdDetailPage } from "./pages/HouseholdDetailPage.js";
import { HouseholdsPage } from "./pages/HouseholdsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { ProjectDetailPage } from "./pages/ProjectDetailPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

// Code-split the pages that draw money flow: they pull in the charting library
// (recharts), which we don't want in the initial bundle for users who never
// open a diagram.
const HouseholdPlanPage = lazy(() =>
  import("./pages/HouseholdPlanPage.js").then((m) => ({ default: m.HouseholdPlanPage })),
);
const FlowPage = lazy(() => import("./pages/FlowPage.js").then((m) => ({ default: m.FlowPage })));

export function App() {
  return (
    <AuthProvider>
      {/* Theme and privacy wrap everything: the drawers and the palette render
          outside the routes and must follow the theme, and blur, too. */}
      <ThemeProvider>
        <PrivacyProvider>
          <QuickAddProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                {/* Password reset is reachable while logged out, by definition. */}
                <Route path="/forgot" element={<ForgotPasswordPage />} />
                <Route path="/reset" element={<ResetPasswordPage />} />
                <Route
                  element={
                    <RequireAuth>
                      <Layout />
                    </RequireAuth>
                  }
                >
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/accounts" element={<AccountsPage />} />
                  <Route path="/accounts/:id" element={<AccountPage />} />
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/projects/:id" element={<ProjectDetailPage />} />
                  <Route path="/households" element={<HouseholdsPage />} />
                  <Route path="/households/:id" element={<HouseholdDetailPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  {/* The diagram, over any set of accounts. Not nested under a
                      household: a household is one preset over that set. */}
                  <Route
                    path="/flow"
                    element={
                      <Suspense fallback={<p className="muted">loading…</p>}>
                        <FlowPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/households/:id/plan"
                    element={
                      <Suspense fallback={<p className="muted">loading…</p>}>
                        <HouseholdPlanPage />
                      </Suspense>
                    }
                  />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              {/* Global quick-add drawers — rendered once, opened via useQuickAdd(). */}
              <NewAccountDrawer />
              <NewIncomeDrawer />
              <NewPaymentDrawer />
              {/* Command palette — listens for ⌘K globally. */}
              <CommandPalette />
            </BrowserRouter>
          </QuickAddProvider>
        </PrivacyProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
