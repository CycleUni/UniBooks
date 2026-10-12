// Vite `?raw` imports: the file's contents as a string (used by config tests).
declare module '*?raw' {
  const content: string;
  export default content;
}
