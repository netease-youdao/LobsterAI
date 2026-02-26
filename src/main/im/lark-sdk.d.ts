/**
 * Type declarations for @larksuiteoapi/node-sdk
 * Minimal types needed for Feishu gateway
 */

declare module '@larksuiteoapi/node-sdk' {
  export const Domain: {
    Feishu: symbol;
    Lark: symbol;
  };

  export const AppType: {
    SelfBuild: symbol;
  };

  export enum LoggerLevel {
    error = 'error',
    warn = 'warn',
    info = 'info',
    debug = 'debug',
  }

  export interface ClientOptions {
    appId: string;
    appSecret: string;
    appType?: symbol;
    domain?: symbol | string;
  }

  export interface WSClientOptions {
    appId: string;
    appSecret: string;
    domain?: symbol | string;
    loggerLevel?: LoggerLevel;
    agent?: any;
  }

  export interface EventDispatcherOptions {
    encryptKey?: string;
    verificationToken?: string;
  }

  export class Client {
    constructor(options: ClientOptions);
    im: {
      message: {
        create(params: {
          params: { receive_id_type: string };
          data: { receive_id: string; content: string; msg_type: string };
        }): Promise<{ code: number; msg?: string; data?: { message_id?: string } }>;
        reply(params: {
          path: { message_id: string };
          data: { content: string; msg_type: string };
        }): Promise<{ code: number; msg?: string; data?: { message_id?: string } }>;
      };
    };
    request(params: {
      method: string;
      url: string;
    }): Promise<{ code: number; msg?: string; data?: any }>;
  }

  export class WSClient {
    constructor(options: WSClientOptions);
    start(options: { eventDispatcher: EventDispatcher }): void;
  }

  export class EventDispatcher {
    constructor(options?: EventDispatcherOptions);
    register(handlers: Record<string, (data: any) => void | Promise<void>>): void;
  }
}
