"use client";

import { useEffect, useRef, useState } from "react";
import qrcode from "./vendor/qrcode.mjs";

export function PairingCard({ roomCode, connected, ready = true, onRelease }: {
  roomCode: string;
  connected: boolean;
  ready?: boolean;
  onRelease: () => void;
}) {
  const [qrImage, setQrImage] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // Relative resolution preserves the /MotionScore/ GitHub Pages base path.
    const url = new URL("./phone.html", window.location.href);
    url.searchParams.set("room", roomCode);
    const qr = qrcode(0, "M");
    qr.addData(url.href);
    qr.make();
    setQrImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true }))}`);
  }, [roomCode]);

  return (
    <div className="pair-card glass-card">
      <span className="panel-label">DEVICE LINK</span>
      {qrImage && ready && <button className="pair-qr-button" onClick={() => dialogRef.current?.showModal()} aria-label="放大配对二维码">
        <img src={qrImage} alt="手机扫码连接当前舞台" width={190} height={190} />
      </button>}
      <strong>{roomCode}</strong>
      <p role="status">{ready ? "手机扫码连接 · 点击二维码放大" : "正在准备配对，请稍候…"}</p>
      <p>扫码后，请点“启用传感”</p>
      {connected && <button className="pair-release" onClick={onRelease}>断开手机</button>}
      <dialog className="pair-dialog" ref={dialogRef} onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}>
        <div className="pair-dialog-content">
          <button className="pair-dialog-close" onClick={() => dialogRef.current?.close()} autoFocus>关闭</button>
          <h2>手机扫码配对</h2>
          {qrImage && <img src={qrImage} alt="手机扫码连接当前舞台" width={400} height={400} />}
          <strong>{roomCode}</strong>
          <p>扫码自动连接，再点“启用传感”</p>
          <p>{connected ? "手机已连接，切换设备前请先断开" : "一次连接一部手机，也可手动输入配对码"}</p>
        </div>
      </dialog>
    </div>
  );
}
