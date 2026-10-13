import net from 'node:net';

/**
 * 极简 RTSP 发布端(仅够把一路 RTP 轨推进 MediaMTX):
 * OPTIONS → ANNOUNCE(SDP) → SETUP(interleaved TCP) → RECORD → 交错帧发送
 */
export class RtspPublisher {
  private socket?: net.Socket;
  private cseq = 0;
  private session = '';
  private buf = Buffer.alloc(0);
  private waiters: { resolve: (resp: RtspResponse) => void; reject: (e: Error) => void }[] = [];
  readonly baseUrl: string;
  private host: string;
  private port: number;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    const u = new URL(baseUrl);
    this.host = u.hostname;
    this.port = Number(u.port) || 8554;
  }

  get sessionId(): string {
    return this.session;
  }

  isAlive(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    this.socket = net.connect(this.port, this.host);
    this.socket.on('data', (c) => this.onData(c));
    this.socket.on('error', () => this.failAll(new Error('rtsp socket error')));
    this.socket.on('close', () => this.failAll(new Error('rtsp socket closed')));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', resolve);
      this.socket!.once('error', reject);
    });
    // OPTIONS 探活(顺带验证服务端在听)
    await this.request('OPTIONS', this.baseUrl);
  }

  async announce(sdp: string): Promise<void> {
    await this.request('ANNOUNCE', this.baseUrl, {
      'Content-Type': 'application/sdp',
    }, sdp);
  }

  async setup(trackUrl: string): Promise<void> {
    const resp = await this.request('SETUP', trackUrl, {
      // mode=record 声明这是发布端(MediaMTX/gortsplib 强制要求)
      Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1;mode=record',
    });
    const sess = resp.headers['session'];
    if (sess) this.session = sess.split(';')[0].trim();
  }

  async record(): Promise<void> {
    await this.request('RECORD', this.baseUrl, {
      ...(this.session ? { Session: this.session } : {}),
      Range: 'npt=0.000-',
    });
  }

  /** 发送一个交错 RTP/RTCP 包(channel 0=RTP, 1=RTCP 回包通道) */
  sendInterleaved(channel: number, payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) return;
    const header = Buffer.alloc(4);
    header.writeUInt8(0x24, 0); // '$'
    header.writeUInt8(channel, 1);
    header.writeUInt16BE(payload.length, 2);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    this.socket?.destroy();
  }

  private failAll(e: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  private request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<RtspResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('rtsp 未连接'));
      const cseq = ++this.cseq;
      const lines = [
        `${method} ${url} RTSP/1.0`,
        `CSeq: ${cseq}`,
        'User-Agent: RemoteAndroid/1.0',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      lines.push('', body ?? '');
      this.waiters.push({ resolve, reject });
      this.socket.write(lines.join('\r\n'));
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      // 交错帧(RTCP 回包等):跳过并上报给调用方
      if (this.buf.length >= 1 && this.buf[0] === 0x24) {
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        const payload = Buffer.from(this.buf.subarray(4, 4 + len));
        const channel = this.buf[1];
        this.buf = this.buf.subarray(4 + len);
        this.onRtcp?.(channel, payload);
        continue;
      }
      // RTSP 响应:到 \r\n\r\n 为止(可能有 Content-Length 体)
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headText = this.buf.toString('latin1', 0, headerEnd);
      const clMatch = /content-length:\s*(\d+)/i.exec(headText);
      const bodyLen = clMatch ? Number(clMatch[1]) : 0;
      if (this.buf.length < headerEnd + 4 + bodyLen) return;
      const body = this.buf.toString('latin1', headerEnd + 4, headerEnd + 4 + bodyLen);
      this.buf = this.buf.subarray(headerEnd + 4 + bodyLen);

      const statusLine = headText.split('\r\n')[0];
      const statusMatch = /^RTSP\/1\.0\s+(\d+)/.exec(statusLine);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const headers: Record<string, string> = {};
      for (const line of headText.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const resp: RtspResponse = { status, headers, body };
      const w = this.waiters.shift();
      if (w) {
        if (status >= 200 && status < 300) w.resolve(resp);
        else w.reject(new Error(`RTSP ${status}: ${body || statusLine}`));
      }
    }
  }

  /** RTCP 回包回调(PLI/FIR 等,订阅后可触发关键帧策略) */
  onRtcp?: (channel: number, payload: Buffer) => void;
}

interface RtspResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
