import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext.js";
import { Layout, RequireAuth } from "./components/Layout.js";
import { NewAccountDrawer } from "./components/NewAccountDrawer.js";
import { NewIncomeDrawer } from "./components/NewIncomeDrawer.js";
import { NewPaymentDrawer } from "./components/NewPaymentDrawer.js";
import { QuickAddProvider } from "./contexts/QuickAddContext.js";
import { AccountPage } from "./pages/AccountPage.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { HouseholdDetailPage } from "./pages/HouseholdDetailPage.js";
import { HouseholdsPage } from "./pages/HouseholdsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";

export function App() {
  return (
    <AuthProvider>
      <QuickAddProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
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
              <Route path="/households" element={<HouseholdsPage />} />
              <Route path="/households/:id" element={<HouseholdDetailPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          {/* Global quick-add drawers — rendered once, opened via useQuickAdd(). */}
          <NewAccountDrawer />
          <NewIncomeDrawer />
          <NewPaymentDrawer />
        </BrowserRouter>
      </QuickAddProvider>
    </AuthProvider>
  );
}
