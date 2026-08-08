export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  dueDate: string | null;
  url: string;
  updatedAt: string;
  archivedAt: string | null;
  assignee: { id: string } | null;
  team: LinearTeam;
  state: LinearWorkflowState;
}

export interface LinearAssignedSnapshot {
  viewerId: string;
  issues: LinearIssue[];
}

export interface LinearIssueUpdate {
  title?: string;
  description?: string | null;
  priority?: number;
  dueDate?: string | null;
  stateId?: string;
}

export interface LinearClient {
  viewerAssignedIssues(signal?: AbortSignal): Promise<LinearAssignedSnapshot>;
  issuesByIds(ids: readonly string[], signal?: AbortSignal): Promise<LinearIssue[]>;
  teamStates(teamId: string, signal?: AbortSignal): Promise<LinearWorkflowState[]>;
  updateIssue(id: string, input: LinearIssueUpdate, signal?: AbortSignal): Promise<LinearIssue>;
  createComment(issueId: string, body: string, signal?: AbortSignal): Promise<{ id: string }>;
}
