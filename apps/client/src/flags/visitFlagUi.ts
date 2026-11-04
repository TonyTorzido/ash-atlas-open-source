export type VisitFlagUiState = {
  selectedFlagId: string | null;
  flagListOpen: boolean;
};

export function visitFlagSucceededUiState(state: VisitFlagUiState): VisitFlagUiState {
  return {
    ...state,
    selectedFlagId: null,
    flagListOpen: false
  };
}

export function visitFlagFailedUiState(state: VisitFlagUiState): VisitFlagUiState {
  return state;
}

export function markFlagVisitCompleted(
  requestId: string | undefined,
  completedRequestIds: Set<string>,
  limit = 100
): boolean {
  if (!requestId) return true;
  if (completedRequestIds.has(requestId)) return false;
  completedRequestIds.add(requestId);
  if (completedRequestIds.size > limit) {
    completedRequestIds.clear();
    completedRequestIds.add(requestId);
  }
  return true;
}
