export interface TuiMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  timestamp: Date;
}

export function createTuiMessage(role: TuiMessage["role"], content: string): TuiMessage {
  return {
    content,
    id: crypto.randomUUID(),
    role,
    timestamp: new Date(),
  };
}
