import React from 'react';
import { Box, Text } from 'ink';
import type { TaskStatusSnapshot } from '../../../status/task-status.js';
import { uiText, displayStatus } from '../../../localization/messages.js';
import { formatTaskStatus } from '../../../status/format-task-status.js';
export { formatTaskStatus } from '../../../status/format-task-status.js';
export function TaskStatus({ snapshot, details = false, maxOutputTokens }: {
    snapshot: TaskStatusSnapshot;
    details?: boolean;
    maxOutputTokens?: number;
}) { const lines = formatTaskStatus(snapshot, maxOutputTokens); const visible = details ? lines : [lines[0]!, ...(snapshot.blocker ? [lines.find(line => line === uiText('task.blocker', { p0: displayStatus(snapshot.blocker) }))!] : []), ...(snapshot.stage === 'blocked' || snapshot.stage === 'awaiting_approval' || snapshot.stage === 'awaiting_input' ? [lines.find(line => line === uiText('task.next', { p0: displayStatus(snapshot.nextAction), p1: displayStatus(snapshot.recovery) }))!] : [])]; return <Box flexDirection="column">{visible.map((line, index) => <Text key={index} wrap="wrap">{line}</Text>)}</Box>; }
