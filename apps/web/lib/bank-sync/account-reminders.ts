type Timestamp = Date | string;
export type ReminderAccount = {
  isEnabled: boolean;
  accountId: string | null;
  securityAccountId: string | null;
  unsharedAt: Timestamp | null;
  createdAt: Timestamp;
};
export type ReminderConnection = {
  status: string;
  mappingConfirmedAt: Timestamp | null;
  newAccountsAvailableAt: Timestamp | null;
  accounts: ReminderAccount[];
};
export function accountReminders(connection: ReminderConnection) {
  const active = connection.status !== "revoked";
  const newAccountsAvailable = active && Boolean(connection.newAccountsAvailableAt);
  const unmappedNewAccounts =
    active && connection.mappingConfirmedAt
      ? connection.accounts.filter(
          (account) =>
            !account.isEnabled &&
            !account.unsharedAt &&
            new Date(account.createdAt).getTime() > new Date(connection.mappingConfirmedAt!).getTime(),
        ).length
      : 0;
  const unsharedMapped = active
    ? connection.accounts.filter(
        (account) =>
          account.unsharedAt && account.isEnabled && (account.accountId || account.securityAccountId),
      ).length
    : 0;
  return {
    newAccountsAvailable,
    unmappedNewAccounts,
    unsharedMapped,
    needsAttention: newAccountsAvailable || unmappedNewAccounts > 0 || unsharedMapped > 0,
  };
}
