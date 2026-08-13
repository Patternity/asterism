import { Route, Routes } from 'react-router-dom';

import { ProtectedLayout } from './components';
import {
  AuditPage,
  InvitationAcceptPage,
  LoginPage,
  MembersPage,
  NodeDetailPage,
  NodesPage,
  OrganizationSelectorPage,
  OverviewPage,
  ProjectDetailPage,
  ProjectsPage,
  RunDetailPage,
  RunsPage,
} from './pages';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitationAcceptPage />} />
      <Route path="/select-organization" element={<OrganizationSelectorPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="nodes/:nodeId" element={<NodeDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
    </Routes>
  );
}
