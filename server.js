const express = require("express")
const app = express()
const fs = require("fs")
const https = require("https")
const { Server } = require("socket.io")
const mediasoup = require("mediasoup")

// SSL 인증서 설정
const options = {
  key: fs.readFileSync("./cert/key.pem"), // 비공개 키
  cert: fs.readFileSync("./cert/cert.pem"), // 인증서
}

// HTTPS 서버 생성
const httpsServer = https.createServer(options, app)
const io = new Server(httpsServer)

// mediasoup 설정
const config = {
  worker: {
    rtcMinPort: 10000, // WebRTC 포트 범위 (최소)
    rtcMaxPort: 10100, // WebRTC 포트 범위 (최대)
    logLevel: "debug", // 로그 레벨
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"], // 로그 태그
  },
  router: {
    mediaCodecs: [
      {
        kind: "audio", // 오디오 코덱
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video", // 비디오 코덱
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000, // 초기 비트레이트
        },
      },
    ],
  },
  webRtcTransport: {
    listenIps: [
      {
        ip: "0.0.0.0", // 모든 인터페이스에서 수신
        announcedIp: "192.168.137.156", // 실제 공인 IP로 대체 필요
      },
    ],
    initialAvailableOutgoingBitrate: 1000000, // 초기 송출 비트레이트
  },
}

// 정적 파일 제공
app.use(express.static("public"))

// 모듈 분리: 워커 관리
const WorkerManager = {
  worker: null, // mediasoup Worker 인스턴스
  router: null, // mediasoup Router 인스턴스

  async initialize() {
    this.worker = await mediasoup.createWorker({
      ...config.worker,
    })

    // Worker 종료 처리
    this.worker.on("died", () => {
      console.error("mediasoup worker died, exiting in 2 seconds...")
      setTimeout(() => process.exit(1), 2000)
    })

    // Router 생성
    this.router = await this.worker.createRouter({
      mediaCodecs: config.router.mediaCodecs,
    })

    console.log("Mediasoup Worker and Router initialized.")
  },
}

// 방/피어 관리
const SocketHandlers = {
  rooms: new Map(), // 방 정보 (roomId -> Set<socketId>)
  peers: new Map(), // 피어 정보 (socketId -> { ...peerData })

  // 전역(또는 방 범위) Producer 관리 맵: producerId -> producer
  // - 다른 피어가 만든 producer를 검색할 때도 사용
  globalProducers: new Map(),

  handleConnection(socket) {
    console.log("Client connected:", socket.id)

    const peer = {
      socket,
      transports: new Map(), // 트랜스포트 관리
      producers: new Map(), // 현재 피어가 소유한 producer
      consumers: new Map(), // 현재 피어가 소유한 consumer
      roomId: null,
    }

    this.peers.set(socket.id, peer)

    // 1) 라우터 RTP Capabilities 요청 처리
    socket.on("getRouterRtpCapabilities", (callback) => {
      console.log(`[${socket.id}] getRouterRtpCapabilities requested`)
      try {
        const caps = WorkerManager.router.rtpCapabilities
        console.log(`[${socket.id}] Router Caps:`, caps)
        callback({ ok: true, routerRtpCapabilities: caps })
      } catch (err) {
        console.error(`[${socket.id}] getRouterRtpCapabilities error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 2) 방 참여 요청
    socket.on("joinRoom", ({ roomId }, callback) => {
      console.log(`[${socket.id}] joinRoom -> ${roomId}`)
      try {
        if (!this.rooms.has(roomId)) {
          this.rooms.set(roomId, new Set())
          console.log(`new roomId = ${roomId}`)
        }

        this.rooms.get(roomId).add(socket.id)
        peer.roomId = roomId

        // 이미 방에 존재하는 Producer 목록을 수집 (나 자신 제외)
        const producers = []
        this.rooms.get(roomId).forEach((peerId) => {
          if (peerId !== socket.id) {
            const otherPeer = this.peers.get(peerId)
            otherPeer.producers.forEach((producer) => {
              producers.push({
                producerId: producer.id,
                peerId,
                kind: producer.kind,
              })
            })
          }
        })

        console.log(`[${socket.id}] Current producers in room:`, producers)
        callback({ ok: true, producers })
      } catch (err) {
        console.error(`[${socket.id}] joinRoom error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 3) WebRTC 트랜스포트 생성 요청
    socket.on("createWebRtcTransport", async ({ sender }, callback) => {
      console.log(`[${socket.id}] createWebRtcTransport (sender: ${sender})`)
      try {
        const transport = await WorkerManager.router.createWebRtcTransport(config.webRtcTransport)
        peer.transports.set(transport.id, transport)

        console.log(`[${socket.id}] Transport created -> id=${transport.id}, sender=${sender}`)

        // DTLS 상태 변경 로깅
        transport.on("dtlsstatechange", (dtlsState) => {
          console.log(`[${socket.id}] DTLS State Change -> ${dtlsState}`)
          if (dtlsState === "closed") transport.close()
        })

        callback({
          ok: true,
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
          },
        })
      } catch (err) {
        console.error(`[${socket.id}] createWebRtcTransport error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 4) 트랜스포트 연결
    socket.on("connectTransport", async ({ transportId, dtlsParameters }, callback) => {
      console.log(`[${socket.id}] connectTransport -> transportId=${transportId}`)
      try {
        const transport = peer.transports.get(transportId)
        if (!transport) {
          throw new Error(`Transport not found: ${transportId}`)
        }
        await transport.connect({ dtlsParameters })
        console.log(`[${socket.id}] Transport connected -> ${transportId}`)
        callback({ ok: true })
      } catch (err) {
        console.error(`[${socket.id}] connectTransport error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 5) 프로듀서 생성 요청
    socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
      console.log(`[${socket.id}] produce -> transportId=${transportId}, kind=${kind}`)
      const transport = peer.transports.get(transportId)
      if (!transport) {
        console.warn(`[${socket.id}] produce failed: Transport not found`)
        return callback({ ok: false, error: "Transport not found" })
      }
      try {
        // Producer 생성
        const producer = await transport.produce({ kind, rtpParameters })

        // 현재 피어의 producers에 등록
        peer.producers.set(producer.id, producer)

        // 전역(또는 방) 맵에 등록, 다른 피어도 lookup 가능
        this.globalProducers.set(producer.id, producer)

        console.log(`[${socket.id}] Producer created -> id=${producer.id}, kind=${kind}`)

        // 트랜스포트 종료 시 Producer 정리
        producer.on("transportclose", () => {
          console.log(`[${socket.id}] Producer closed (transportclose) -> ${producer.id}`)
          peer.producers.delete(producer.id)
          this.globalProducers.delete(producer.id) // 전역 맵에서도 제거
        })

        // 방 내 다른 피어에게 Producer 존재 알림
        const room = this.rooms.get(peer.roomId)
        if (room) {
          room.forEach((peerId) => {
            if (peerId !== socket.id) {
              console.log(`[${socket.id}] Notifying newProducer to -> ${peerId}`)
              const otherPeer = this.peers.get(peerId)
              otherPeer.socket.emit("newProducer", {
                producerId: producer.id,
                peerId: socket.id, // producer 소유자
                kind,
              })
            }
          })
        }

        callback({ ok: true, id: producer.id })
      } catch (err) {
        console.error(`[${socket.id}] produce error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 6) 소비자(Consumer) 생성 요청
    socket.on("consume", async ({ transportId, producerId, rtpCapabilities }, callback) => {
      console.log(`[${socket.id}] consume -> producerId=${producerId}`)

      const peer = this.peers.get(socket.id) // 현재 피어
      if (!peer) {
        return callback({ ok: false, error: "Peer not found" })
      }

      // 'globalProducers' 맵에서 producerId로 Producer 찾기
      const producer = this.globalProducers.get(producerId)
      if (!producer) {
        console.warn(`[${socket.id}] consume failed: Producer not found -> ${producerId}`)
        return callback({ ok: false, error: "Cannot consume" })
      }

      // 코덱 호환 여부 확인
      if (!WorkerManager.router.canConsume({ producerId, rtpCapabilities })) {
        console.warn(`[${socket.id}] cannot consume producerId=${producerId}`)
        return callback({ ok: false, error: "Cannot consume" })
      }

      try {
        // 'transportId'로 피어가 보유한 consumerTransport 가져오기
        const transport = peer.transports.get(transportId)
        if (!transport) {
          console.warn(`[${socket.id}] consume failed: Transport not found -> ${transportId}`)
          return callback({ ok: false, error: `Transport not found: ${transportId}` })
        }

        // Consumer 생성
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // 필요 시 true
        })

        await consumer.resume()

        // 현재 피어 Consumer 목록에도 등록
        peer.consumers.set(consumer.id, consumer)

        console.log(`[${socket.id}] Consumer created -> id=${consumer.id}`)

        // 이벤트 핸들러
        consumer.on("transportclose", () => {
          console.log(`[${socket.id}] Consumer closed (transportclose) -> ${consumer.id}`)
          peer.consumers.delete(consumer.id)
        })

        consumer.on("producerclose", () => {
          console.log(`[${socket.id}] Consumer closed (producerclose) -> ${consumer.id}`)
          peer.consumers.delete(consumer.id)
          socket.emit("producerClosed", { producerId })
        })

        // 클라이언트 쪽에 Consumer 정보를 반환
        callback({
          ok: true,
          params: {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        })
      } catch (err) {
        console.error(`[${socket.id}] consume error:`, err)
        callback({ ok: false, error: err.message })
      }
    })

    // 7) 클라이언트 연결 해제
    socket.on("disconnect", () => {
      console.log(`[${socket.id}] disconnected`)
      this.cleanupPeer(socket.id)
    })
  },

  // 피어 정리
  cleanupPeer(socketId) {
    const peer = this.peers.get(socketId)
    if (!peer) return

    if (peer.roomId) {
      const room = this.rooms.get(peer.roomId)
      if (room) {
        room.delete(socketId)
        if (room.size === 0) {
          this.rooms.delete(peer.roomId)
        } else {
          room.forEach((pid) => {
            const otherPeer = this.peers.get(pid)
            otherPeer.socket.emit("peerClosed", { peerId: socketId })
          })
        }
      }
    }

    // 종료 시 transport, producer, consumer 정리
    peer.transports.forEach((transport) => {
      console.log(`[${socketId}] closing transport -> ${transport.id}`)
      transport.close()
    })

    // 현재 피어 소유 Producer는 globalProducers에서도 제거
    peer.producers.forEach((producer, producerId) => {
      this.globalProducers.delete(producerId)
    })

    this.peers.delete(socketId)
  },
}

io.on("connection", (socket) => SocketHandlers.handleConnection(socket))

// 서버 시작
async function start() {
  await WorkerManager.initialize()

  const port = process.env.PORT || 4000
  httpsServer.listen(port, () => {
    console.log(`Server running at https://${config.webRtcTransport.listenIps[0].announcedIp}:${port}`)
  })
}

start()
