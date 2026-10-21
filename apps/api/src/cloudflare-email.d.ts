/** Workers runtime module (only resolvable on Cloudflare; imported lazily by worker.ts). */
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}
