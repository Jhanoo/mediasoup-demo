const express = require("express");
const app = express();
const fs = require("fs");
const https = require("https");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

// SSL 인증서 설정
const options = {
  key: fs.readFileSync("./cert/key.pem"),
  cert: fs.readFileSync("./cert/cert.pem"),
};

// HTTPS 서버 생성
const httpsServer = https.createServer(options, app);
const io = new Server(httpsServer);

// mediasoup 워커와 라우터를 저장할 변수
let worker;
let router;

// mediasoup 설정
const config = {
  mediasoup: {
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: "debug",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
      ],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "127.0.0.1", // 실제 서버에서는 공인 IP로 변경 필요
        },
      ],
      initialAvailableOutgoingBitrate: 1000000,
    },
  },
};

// 정적 파일 제공
app.use(express.static("public"));

// mediasoup 워커 생성
async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exiting in 2 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 2000);
  });

  // mediasoup 라우터 생성
  router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });
  console.log("mediasoup 워커와 라우터가 생성되었습니다.");
}

// WebRTC Transport 생성 함수
async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp: "127.0.0.1", // 실제 서버에서는 공인 IP로 변경 필요
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
  });

  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "closed") {
      transport.close();
    }
  });

  transport.on("close", () => {
    console.log("transport closed");
  });

  return transport;
}

// 룸과 피어 정보를 저장할 맵
const rooms = new Map();
const peers = new Map();

io.on("connection", async (socket) => {
  console.log("클라이언트가 연결되었습니다:", socket.id);

  // 피어 객체 생성
  const peer = {
    socket,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    roomId: null,
  };

  peers.set(socket.id, peer);

  // RTP Capabilities 요청 처리 수정
  socket.on("getRouterRtpCapabilities", (callback) => {
    if (typeof callback !== 'function') {
        console.log(`callback = ${callback}`)
        console.warn('getRouterRtpCapabilities: callback is not a function');
        return;
    }
    try {
        console.log(`rtpCapabilities = ${router.rtpCapabilities}`)
        callback({ ok: true, routerRtpCapabilities: router.rtpCapabilities });
    } catch (error) {
        console.error('getRouterRtpCapabilities error:', error);
        callback({ ok: false, error: error.message });
    }
});

  // 방 참가 처리
  socket.on("joinRoom", async ({ roomId }, callback) => {
    try {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      rooms.get(roomId).add(socket.id);
      peer.roomId = roomId;

      const producerList = [];
      rooms.get(roomId).forEach((peerId) => {
        if (peerId !== socket.id) {
          const otherPeer = peers.get(peerId);
          otherPeer.producers.forEach((producer) => {
            producerList.push({
              producerId: producer.id,
              peerId: peerId,
              kind: producer.kind,
            });
          });
        }
      });

      callback({ ok: true, producerList });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  // Transport 생성 요청 처리
  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    try {
      const transport = await createWebRtcTransport(router);
      peer.transports.set(transport.id, transport);

      callback({
        ok: true,
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        },
      });
    } catch (err) {
      console.error("createWebRtcTransport error:", err);
      callback({ ok: false, error: err.message });
    }
  });

  // Transport 연결 설정
  socket.on(
    "connectTransport",
    async ({ transportId, dtlsParameters }, callback) => {
      try {
        const transport = peer.transports.get(transportId);
        if (!transport) {
          throw new Error(`transport with id ${transportId} not found`);
        }
        await transport.connect({ dtlsParameters });
        callback({ ok: true });
      } catch (err) {
        callback({ ok: false, error: err.message });
      }
    }
  );

  // Producer 생성 처리
  socket.on(
    "produce",
    async ({ transportId, kind, rtpParameters }, callback) => {
      try {
        const transport = peer.transports.get(transportId);
        if (!transport) {
          throw new Error(`transport with id ${transportId} not found`);
        }

        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.set(producer.id, producer);

        // 같은 방의 다른 참가자들에게 새 producer 알림
        if (peer.roomId) {
          rooms.get(peer.roomId).forEach((peerId) => {
            if (peerId !== socket.id) {
              peers.get(peerId).socket.emit("newProducer", {
                producerId: producer.id,
                peerId: socket.id,
                kind: producer.kind,
              });
            }
          });
        }

        producer.on("transportclose", () => {
          producer.close();
          peer.producers.delete(producer.id);
        });

        callback({ ok: true, id: producer.id });
      } catch (err) {
        callback({ ok: false, error: err.message });
      }
    }
  );

  // Consumer 생성 처리
  socket.on(
    "consume",
    async ({ transportId, producerId, rtpCapabilities }, callback) => {
      try {
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("cannot consume");
        }

        const transport = peer.transports.get(transportId);
        if (!transport) {
          throw new Error(`transport with id ${transportId} not found`);
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        peer.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          consumer.close();
          peer.consumers.delete(consumer.id);
        });

        callback({
          ok: true,
          params: {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused,
          },
        });
      } catch (err) {
        callback({ ok: false, error: err.message });
      }
    }
  );

  // Consumer 재개 처리
//   socket.on("resume", async (callback) => {
//     callback({ ok: true });
//   });

  socket.on("disconnect", () => {
    console.log("클라이언트가 연결을 해제했습니다:", socket.id);

    // 방에서 피어 제거
    if (peer.roomId) {
      const room = rooms.get(peer.roomId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(peer.roomId);
        } else {
          // 남은 참가자들에게 피어 퇴장 알림
          room.forEach((peerId) => {
            peers.get(peerId).socket.emit("peerClosed", { peerId: socket.id });
          });
        }
      }
    }

    // 피어의 모든 리소스 정리
    for (const transport of peer.transports.values()) {
      transport.close();
    }
    peers.delete(socket.id);
  });
});

// 서버 시작
async function start() {
  await createWorker();

  const port = process.env.PORT || 4000;
  httpsServer.listen(port, () => {
    console.log(`서버가 https://localhost:${port} 에서 실행 중입니다`);
  });
}

start();
