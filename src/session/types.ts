import type { Message } from "../types.js";

export interface SessionEntry {
	timestamp: string;
	message: Message;
}
