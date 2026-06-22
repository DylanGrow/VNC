import { z } from 'zod';

// Mouse input event schema validation
export const MouseEventSchema = z.object({
  type: z.enum(['mouse_move', 'mouse_down', 'mouse_up', 'click', 'double_click', 'scroll']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  button: z.enum(['left', 'middle', 'right']).optional(),
  deltaY: z.number().optional(),
  monitorId: z.number().int().positive().default(1)
});

// Keyboard input event schema validation
export const KeyboardEventSchema = z.object({
  type: z.enum(['key_press', 'key_release']),
  key: z.string().min(1),
  monitorId: z.number().int().positive().default(1)
});

// Clipboard synchronization payload schema validation
export const ClipboardSchema = z.object({
  data: z.string().max(102400) // matches 100 KB backend limit
});

// WebSocket frame payload schema validation
export const FrameMessageSchema = z.object({
  type: z.literal('frame'),
  sequence: z.number().nonnegative(),
  data: z.string(),
  x: z.number().nonnegative().default(0),
  y: z.number().nonnegative().default(0),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  is_delta: z.boolean().default(false),
  timestamp: z.string()
});

// WebSocket ping payload schema validation
export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  id: z.number(),
  timestamp: z.string().optional()
});

export type MouseEventData = z.infer<typeof MouseEventSchema>;
export type KeyboardEventData = z.infer<typeof KeyboardEventSchema>;
export type ClipboardData = z.infer<typeof ClipboardSchema>;
export type FrameMessage = z.infer<typeof FrameMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
