import type { Content } from "./content.js";
import type { Role } from "./role.js";

interface UserMessage {
  role: "user";
  content: Content | Content[];
}

export interface Message {
  role: Role;
}
