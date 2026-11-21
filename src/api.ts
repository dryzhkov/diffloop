export interface WorkspaceStatus {
  accounts: number;
  credentialStorageAvailable: boolean;
}

export interface WorkspaceApi {
  status(): Promise<WorkspaceStatus>;
}
