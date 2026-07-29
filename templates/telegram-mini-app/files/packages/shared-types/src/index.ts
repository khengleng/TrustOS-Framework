/**
 * Types shared between the API, the admin application and the Mini App.
 *
 * Runtime-free by design. Note that `initData` is not modelled here: it is a
 * credential, and a shared type invites it being stored or forwarded.
 */

export type TaskStatus = 'TODO' | 'DOING' | 'DONE';

export interface TelegramProfileSummary {
  id: string;
  organizationId: string;
  telegramUserId: string;
  userId: string;
  username: string | null;
  firstName: string | null;
  languageCode: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  organizationId: string;
  telegramProfileId: string;
  title: string;
  status: TaskStatus;
  completedAt: string | null;
  createdAt: string;
}

export interface MiniAppSessionResponse {
  profile: TelegramProfileSummary;
  telegramUser: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    languageCode: string | null;
    isPremium: boolean;
  };
}
