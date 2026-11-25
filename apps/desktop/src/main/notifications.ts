import { app, Notification } from 'electron';

export interface NotificationInput {
  title: string;
  body: string;
  sessionId?: string;
  urgent?: boolean;
}

/**
 * Electron notifications are garbage collected when no JavaScript reference is
 * left, which on Windows drops the toast before the user can click it.
 */
const MAX_RETAINED = 10;
const retained: Notification[] = [];

export function notificationsDisabled(): boolean {
  return process.env.NEST_DISABLE_NOTIFICATIONS === '1';
}

export function showNotification(
  input: NotificationInput,
  onClick: (sessionId: string | undefined) => void,
): boolean {
  if (notificationsDisabled() || !Notification.isSupported()) return false;

  const notification = new Notification({
    title: input.title,
    body: input.body,
    urgency: input.urgent ? 'critical' : 'normal',
  });
  notification.on('click', () => onClick(input.sessionId));
  notification.on('close', () => {
    const index = retained.indexOf(notification);
    if (index >= 0) retained.splice(index, 1);
  });

  retained.push(notification);
  if (retained.length > MAX_RETAINED) retained.shift();
  notification.show();
  return true;
}

/**
 * Dock/taskbar badge on platforms that support it. Windows ignores the count,
 * so the tray tooltip is updated separately by the caller.
 */
export function setAppBadge(count: number): void {
  try {
    app.setBadgeCount(Math.max(0, count));
  } catch {
    // Not every desktop environment exposes a badge.
  }
}
