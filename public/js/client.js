import { Device } from "mediasoup-client"

class VideoChat {
  constructor() {
    // 소켓 연결 설정
    this.socket = io({
      secure: true,
      rejectUnauthorized: false,
    })

    // mediasoup-client의 Device 인스턴스
    this.device = null

    // 송신/수신 트랜스포트
    this.producerTransport = null
    this.consumerTransport = null

    // 트랙 관리
    this.producers = new Map()
    this.consumers = new Map()

    // 미디어 트랙 상태
    this.isProducing = false
    this.roomId = "room1"
    this.localVideo = null
    this.localStream = null
    this.isMuted = false
    this.isVideoOff = false

    // UI 요소 초기화
    this.initializeElements()

    // 소켓 이벤트 핸들러 등록
    this.addSocketListeners()
  }

  // DOM 요소 설정
  initializeElements() {
    this.videoContainer = document.getElementById("videoContainer")
    this.joinBtn = document.getElementById("joinBtn")
    this.muteBtn = document.getElementById("muteBtn")
    this.videoBtn = document.getElementById("videoBtn")
    this.leaveBtn = document.getElementById("leaveBtn")

    this.joinBtn.addEventListener("click", () => this.joinRoom())
    this.muteBtn.addEventListener("click", () => this.toggleMute())
    this.videoBtn.addEventListener("click", () => this.toggleVideo())
    this.leaveBtn.addEventListener("click", () => this.leaveRoom())
  }

  // 소켓 이벤트 등록
  addSocketListeners() {
    this.socket.on("connect", () => {
      console.log("[client] Socket connected ->", this.socket.id)
    })

    // 서버에서 새로운 프로듀서 알림 수신 시
    this.socket.on("newProducer", async ({ producerId, peerId, kind }) => {
      // 1) 자기 자신이 만든 Producer인지 확인
      if (peerId === this.socket.id) {
        console.log("[client] Skipping own producer (newProducer event).")
        return // 자기 자신이면 consume X
      }

      console.log(`[client] newProducer event: producerId=${producerId}, peerId=${peerId}, kind=${kind}`)
      try {
        await this.consume(producerId, peerId, kind)
      } catch (err) {
        console.error("[client] consume error:", err)
      }
    })

    // 서버에서 피어가 끊겼다는 알림 수신 시
    this.socket.on("peerClosed", ({ peerId }) => {
      console.log(`[client] peerClosed event: peerId=${peerId}`)
      this.removeVideoElement(peerId)
    })

    // producer가 종료됨
    this.socket.on("producerClosed", ({ producerId }) => {
      console.log(`[client] producerClosed -> producerId=${producerId}`)
    })
  }

  // 방 참가
  async joinRoom() {
    try {
      console.log("[client] joinRoom called")
      // 1) 로컬 스트림 획득
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      })

      console.log("[client] Got localStream:", this.localStream)
      this.displayLocalVideo()

      // 2) 서버에 joinRoom 요청
      console.log("[client] Emitting joinRoom ->", this.roomId)
      const joinResponse = await this.emitWithPromise("joinRoom", {
        roomId: this.roomId,
      })
      console.log("[client] joinRoom response:", joinResponse)

      if (!joinResponse.ok) {
        throw new Error(joinResponse.error || "joinRoom failed")
      }

      // 3) 서버의 RTP Capabilities 가져오기
      const rtpCapResponse = await this.getRouterRtpCapabilities()
      console.log("[client] getRouterRtpCapabilities response:", rtpCapResponse)

      if (!rtpCapResponse.ok) {
        throw new Error(rtpCapResponse.error || "RTP Capabilities failed")
      }

      // 4) Device 생성
      console.log("[client] Creating Device...")
      this.device = new Device()
      await this.device.load({
        routerRtpCapabilities: rtpCapResponse.routerRtpCapabilities,
      })
      console.log("[client] Device loaded.", this.device)

      // 5) 트랜스포트 생성 (송신 / 수신)
      console.log("[client] Creating ProducerTransport...")
      await this.createProducerTransport()
      console.log("[client] ProducerTransport created.")

      console.log("[client] Creating ConsumerTransport...")
      await this.createConsumerTransport()
      console.log("[client] ConsumerTransport created.")

      // 6) 프로듀서 생성 (오디오 / 비디오)
      console.log("[client] Creating producers...")
      await this.produce("video")
      await this.produce("audio")

      // 7) 기존 프로듀서 소비
      for (const { producerId, peerId, kind } of joinResponse.producers) {
        // 자기 자신이 만든 Producer인지 확인
        if (peerId === this.socket.id) {
          console.log("[client] Skipping own producer in joinRoom producers list.")
          continue // 자기 자신이면 consume X
        }

        console.log(`[client] consuming existing producer -> ${producerId}, kind=${kind}`)
        await this.consume(producerId, peerId, kind)
      }

      // joinRoom 성공 시 버튼 비활성화
      this.joinBtn.disabled = true
    } catch (err) {
      console.error("[client] joinRoom error:", err)
      alert("오류가 발생했습니다: " + err.message)
    }
  }

  // 라우터 RTP Capabilities 요청
  getRouterRtpCapabilities() {
    console.log("[client] getRouterRtpCapabilities called")
    return new Promise((resolve) => {
      this.socket.emit("getRouterRtpCapabilities", (response) => {
        resolve(response)
      })
    })
  }

  // 송신 트랜스포트 생성
  async createProducerTransport() {
    console.log("[client] createProducerTransport emit...")
    const { ok, params, error } = await this.emitWithPromise("createWebRtcTransport", {
      sender: true,
    })

    if (!ok) {
      throw new Error(error || "createProducerTransport failed")
    }

    console.log("[client] ProducerTransport params:", params)
    this.producerTransport = this.device.createSendTransport(params)

    // 연결
    this.producerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
      console.log("[client] ProducerTransport connect event", dtlsParameters)
      try {
        const connectResp = await this.emitWithPromise("connectTransport", {
          transportId: this.producerTransport.id,
          dtlsParameters,
        })
        console.log("[client] connectTransport response:", connectResp)
        callback()
      } catch (error) {
        errback(error)
      }
    })

    // produce
    this.producerTransport.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
      console.log("[client] ProducerTransport produce event -> kind:", kind)
      try {
        const produceResp = await this.emitWithPromise("produce", {
          transportId: this.producerTransport.id,
          kind,
          rtpParameters,
        })
        console.log("[client] produce response:", produceResp)
        if (!produceResp.ok) {
          throw new Error(produceResp.error)
        }
        callback({ id: produceResp.id })
      } catch (error) {
        errback(error)
      }
    })
  }

  // 수신 트랜스포트 생성
  async createConsumerTransport() {
    console.log("[client] createConsumerTransport emit...")
    const { ok, params, error } = await this.emitWithPromise("createWebRtcTransport", {
      sender: false,
    })

    if (!ok) {
      throw new Error(error || "createConsumerTransport failed")
    }

    console.log("[client] ConsumerTransport params:", params)
    this.consumerTransport = this.device.createRecvTransport(params)

    this.consumerTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
      console.log("[client] ConsumerTransport connect event", dtlsParameters)
      try {
        const connectResp = await this.emitWithPromise("connectTransport", {
          transportId: this.consumerTransport.id,
          dtlsParameters,
        })
        console.log("[client] connectTransport response:", connectResp)
        callback()
      } catch (error) {
        errback(error)
      }
    })
  }

  // 프로듀서 생성
  async produce(kind) {
    console.log(`[client] produce called -> kind=${kind}`)
    const track = kind === "video" ? this.localStream.getVideoTracks()[0] : this.localStream.getAudioTracks()[0]

    if (!track) {
      console.warn(`[client] No track found for ${kind}`)
      return
    }

    const producer = await this.producerTransport.produce({
      track,
      encodings:
        kind === "video"
          ? [
              { rid: "r0", maxBitrate: 100000 },
              { rid: "r1", maxBitrate: 300000 },
              { rid: "r2", maxBitrate: 900000 },
            ]
          : undefined,
    })

    console.log(`[client] Producer created -> id=${producer.id}, kind=${producer.kind}`)
    this.producers.set(kind, producer)

    producer.on("trackended", () => {
      console.log(`[client] track ended -> ${kind}`)
    })

    producer.on("transportclose", () => {
      console.log(`[client] transport closed -> ${kind}`)
    })
  }

  // 프로듀서를 소비하여 원격 비디오/오디오 표시
  async consume(producerId, peerId, kind) {
    console.log(`[client] consume called -> producerId=${producerId}, peerId=${peerId}, kind=${kind}`)
    const consumeResp = await this.emitWithPromise("consume", {
      transportId: this.consumerTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    })
    console.log("[client] consume response:", consumeResp)

    if (!consumeResp.ok) {
      throw new Error(consumeResp.error || "consume failed")
    }

    const { params } = consumeResp
    const consumer = await this.consumerTransport.consume(params)
    this.consumers.set(consumer.id, consumer)

    const mediaStream = new MediaStream([consumer.track])
    console.log(`[client] consumer track =>`, consumer.track)

    this.displayRemoteVideo(mediaStream, peerId, kind)
    console.log("스트림=", mediaStream.getTracks())

    console.log("[client] Resume consumer...")
    await consumer.resume()
    console.log(`[client] Consumer resumed -> id=${consumer.id}`)

    consumer.on("transportclose", () => {
      {
        console.log(`consumer ${consumer.id} closed`)
      }
    })

    consumer.on("trackended", () => {
      console.log(`trackended ${consumer.id}`)
    })
  }

  // 로컬 비디오 표시
  displayLocalVideo() {
    console.log("[client] displayLocalVideo")
    const videoWrapper = document.createElement("div")
    videoWrapper.className = "video-wrapper"
    videoWrapper.id = "local"

    const video = document.createElement("video")
    video.srcObject = this.localStream
    video.autoplay = true
    video.playsInline = true
    video.muted = true

    videoWrapper.appendChild(video)
    this.videoContainer.appendChild(videoWrapper)
    this.localVideo = video
  }

  // 원격 비디오 표시
  displayRemoteVideo(stream, peerId, kind) {
    console.log(`[client] displayRemoteVideo -> peerId=${peerId}, kind=${kind}`)
    let videoWrapper = document.getElementById(`peer-${peerId}`)

    // 피어별로 video-wrapper가 없으면 생성
    if (!videoWrapper) {
      videoWrapper = document.createElement("div")
      videoWrapper.className = "video-wrapper"
      videoWrapper.id = `peer-${peerId}`

      const video = document.createElement("video")
      video.autoplay = true
      video.playsInline = true

      videoWrapper.appendChild(video)
      this.videoContainer.appendChild(videoWrapper)
    }

    const video = videoWrapper.querySelector("video")

    if (kind === "video") {
      console.log(`[client] mediaStream =>`, stream)
      video.srcObject = stream
    } else {
      const existingStream = video.srcObject
      if (existingStream) {
        existingStream.addTrack(stream.getAudioTracks()[0])
      } else {
        video.srcObject = stream
      }
    }
    // 추가 디버그
    console.log("[client] video.srcObject =", video.srcObject)
  }

  // 비디오 엘리먼트 제거
  removeVideoElement(peerId) {
    console.log(`[client] removeVideoElement -> peerId=${peerId}`)
    const videoWrapper = document.getElementById(`peer-${peerId}`)
    if (videoWrapper) {
      videoWrapper.remove()
    }
  }

  // 음소거 토글
  toggleMute() {
    console.log("[client] toggleMute")
    const audioTrack = this.localStream && this.localStream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      this.isMuted = !audioTrack.enabled
      this.muteBtn.textContent = this.isMuted ? "음소거 해제" : "음소거"
      console.log(`[client] Mute status -> ${this.isMuted}`)
    }
  }

  // 비디오 On/Off
  toggleVideo() {
    console.log("[client] toggleVideo")
    const videoTrack = this.localStream && this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
      this.isVideoOff = !videoTrack.enabled
      this.videoBtn.textContent = this.isVideoOff ? "비디오 켜기" : "비디오 끄기"
      console.log(`[client] Video status -> ${this.isVideoOff}`)
    }
  }

  // 방 떠나기
  async leaveRoom() {
    console.log("[client] leaveRoom")
    // 트랜스포트 닫기
    if (this.producerTransport) {
      this.producerTransport.close()
      console.log("[client] ProducerTransport closed")
    }
    if (this.consumerTransport) {
      this.consumerTransport.close()
      console.log("[client] ConsumerTransport closed")
    }

    // 미디어 스트림 정리
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop())
      console.log("[client] Local stream tracks stopped")
    }

    // UI 정리
    this.videoContainer.innerHTML = ""

    // 소켓 해제
    this.socket.disconnect()
    console.log("[client] Socket disconnected")

    // 버튼 리셋
    this.joinBtn.disabled = false
  }

  // 서버 emit을 Promise 기반으로 호출
  emitWithPromise(event, data = {}) {
    console.log(`[client] emitWithPromise -> event=${event}, data=`, data)
    return new Promise((resolve) => {
      this.socket.emit(event, data, (response) => {
        console.log(`[client] emitWithPromise response -> event=${event}, resp=`, response)
        resolve(response)
      })
    })
  }
}

// 페이지 로드 시 VideoChat 인스턴스 생성
window.addEventListener("load", () => {
  window.videoChat = new VideoChat()
})
