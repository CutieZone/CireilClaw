export interface MemoryBlock {
  label: string;
  description: string;
  filePath: string;
  metadata: {
    chars_current: number;
  };
  content: string;
}
