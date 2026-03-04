import { TSysMsgPushInfo } from './SystemMessageServiceInterface';
import { IBaseSendFileOptions, ISendCustomMsgOptions, ISendGeoLocationMsgOptions, ISendTextMsgOptions, ISendTipMsgOptions, StrAnyObj } from './types';
/**
 * 调用方式:
 * ```js
 * nim.msg.sendTextMsg(options)
 * ```
 */
export interface MsgServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送文本消息
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E5%86%85%E5%AE%B9%E5%AE%A1%E6%A0%B8.js" target="_blank">内容审核</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%8E%A8%E9%80%81.js" target="_blank">推送</a></li>
     * </ul>
     *
     * @example
     * ```js
     * nim.msg.sendTextMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    body: 'text'
     * })
     * ```
     * @locale
     *
     * @locale en
     * Send text messages
     * @locale
     */
    sendTextMsg(options: ISendTextMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送提醒消息
     *
     * 提醒消息用于会话内的状态提醒，如进入会话时出现的欢迎消息，或者会话命中敏感词后的提示消息等等。接收消息的类型为 tip
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @locale
     *
     * @locale en
     * Send notifications
     *
     * Reminder messages are used for status reminders in the session, such as the welcome message when entering the session, the prompt message after the session hits a sensitive word, etc.
     * @locale
     */
    sendTipMsg(options: ISendTipMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送地理位置信息。具体的位置应该通过 attach 属性发送。接收方收到的消息类型为 'geo'
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * nim.msg.sendGeoLocationMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    attach: {
     *        lat: 39.9042,
     *        lng: 116.4074,
     *        title: 'BeiJing'
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send geolocation messages
     * @locale
     */
    sendGeoLocationMsg(options: ISendGeoLocationMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送自定义消息。用户可以使用自定义消息发送一些特殊的内容，比如 emoji，猜拳游戏等
     *
     * 和普通消息相比，自定义消息有以下区别：
     * 1. 增加 attach 字段。建议该字段设置为 字符串化的 JSON 结构
     * 2. 消息的类型为 'custom'
     * 3. 反垃圾字段: `antiSpamContent` 仅对自定义消息有效
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E5%86%85%E5%AE%B9%E5%AE%A1%E6%A0%B8.js" target="_blank">内容审核</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E8%A1%A8%E6%83%85.js" target="_blank">表情</a></li>
     * </ul>
     *
     * @locale
     *
     * @locale en
     * Send custom messages
     * @locale
     */
    sendCustomMsg(options: ISendCustomMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送图片消息。该函数有以下三种使用方式：
     *
     * - 调用 sendImageMsg 上传并发送消息
     * - 先调用 {@link CloudStorageServiceInterface.uploadFile | uploadFile} 上传文件，然后调用 sendImageMsg 发送文件消息
     * - 调用第三方存储上传文件，然后调用 sendImageMsg 发送文件消息
     *
     * 另注：
     * - 若要在取消上传文件，可以调用 onUploadStart 回调参数的 abort 函数
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%96%87%E4%BB%B6%E6%B6%88%E6%81%AF.js" target="_blank">文件消息</a></li>
     * </ul>
     *
     * @example
     * ```js
     * // 上传并发送消息
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendImageMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file
     * })
     * ```
     *
     * @example
     * ```js
     * // 先上传文件，再发送文件消息
     * const file = document.getElementById('file-input').files[0]
     *
     * const uploadFileRes = await nim.cloudStorage.uploadFile({
     *    type: 'image'
     *    file: file
     * })
     *
     * nim.msg.sendImageMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    attach: uploadFileRes
     * })
     * ```
     *
     * @example
     * ```js
     * // 取消上传
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendImageMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file,
     *    onUploadStart: (task) => {
     *        // 调用 abort 取消上传
     *        task.abort()
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send picture messages
     * @locale
     */
    sendImageMsg(options: IBaseSendFileOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送音频消息。该函数有以下三种使用方式：
     *
     * - 1. 调用 sendAudioMsg 上传并发送消息
     * - 2. 先调用 {@link CloudStorageServiceInterface.uploadFile | uploadFile} 上传文件，然后调用 sendAudioMsg 发送文件消息
     * - 3. 调用第三方存储上传文件，然后调用 sendAudioMsg 发送文件消息
     *
     * 另注：
     * - 若要在取消上传文件，可以调用 onUploadStart 回调参数的 abort 函数
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * // 上传并发送消息
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendAudioMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file
     * })
     * ```
     *
     * @example
     * ```js
     * // 先上传文件，再发送文件消息
     * const file = document.getElementById('file-input').files[0]
     *
     * const uploadFileRes = await nim.cloudStorage.uploadFile({
     *    type: 'audio'
     *    file: file
     * })
     *
     * nim.msg.sendAudioMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    attach: uploadFileRes
     * })
     * ```
     *
     * @example
     * ```js
     * // 取消上传
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendAudioMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file,
     *    onUploadStart: (task) => {
     *        // 调用 abort 取消上传
     *        task.abort()
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send audio messages
     * @locale
     */
    sendAudioMsg(options: IBaseSendFileOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送视频消息。该函数有以下三种使用方式：
     *
     * - 1. 调用 sendVideoMsg 上传并发送消息
     * - 2. 先调用 {@link CloudStorageServiceInterface.uploadFile | uploadFile} 上传文件，然后调用 sendVideoMsg 发送文件消息
     * - 3. 调用第三方存储上传文件，然后调用 sendVideoMsg 发送文件消息
     *
     * 另注：
     * - 若要在取消上传文件，可以调用 onUploadStart 回调参数的 abort 函数
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * // 上传并发送消息
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendVideoMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file
     * })
     * ```
     *
     * @example
     * ```js
     * // 先上传文件，再发送文件消息
     * const file = document.getElementById('file-input').files[0]
     *
     * const uploadFileRes = await nim.cloudStorage.uploadFile({
     *    type: 'video'
     *    file: file
     * })
     *
     * nim.msg.sendVideoMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    attach: uploadFileRes
     * })
     * ```
     *
     * @example
     * ```js
     * // 取消上传
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendVideoMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file,
     *    onUploadStart: (task) => {
     *        // 调用 abort 取消上传
     *        task.abort()
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send video messages
     * @locale
     */
    sendVideoMsg(options: IBaseSendFileOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送文件消息。该函数有以下三种使用方式：
     *
     * - 1. 调用 sendFileMsg 上传并发送消息
     * - 2. 先调用 {@link CloudStorageServiceInterface.uploadFile | uploadFile} 上传文件，然后调用 sendFileMsg 发送文件消息
     * - 3. 调用第三方存储上传文件，然后调用 sendFileMsg 发送文件消息
     *
     * 另注：
     * - 若要在取消上传文件，可以调用 onUploadStart 回调参数的 abort 函数
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * // 上传并发送消息
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendFileMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file
     * })
     * ```
     *
     * @example
     * ```js
     * // 先上传文件，再发送文件消息
     * const file = document.getElementById('file-input').files[0]
     *
     * const uploadFileRes = await nim.cloudStorage.uploadFile({
     *    type: 'file'
     *    file: file
     * })
     *
     * nim.msg.sendFileMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    attach: uploadFileRes
     * })
     * ```
     *
     * @example
     * ```js
     * // 取消上传
     * const file = document.getElementById('file-input').files[0]
     *
     * nim.msg.sendFileMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    file: file,
     *    onUploadStart: (task) => {
     *        // 调用 abort 取消上传
     *        task.abort()
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send other file messages
     * @locale
     */
    sendFileMsg(options: IBaseSendFileOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重发某条消息。
     *
     * - 与直接发送消息的区别在于，重发消息不会修改消息的 idClient
     * - 消息发送失败后，可以使用该函数重发消息
     * - 常见发送失败原因：网络问题、被拉黑
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * try {
     *  let tempMsg
     *  await nim.msg.sendTextMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    body: 'message',
     *    onSendBefore: (msg) => {
     *      // 发送消息前，通过该回调临时存储消息
     *      tempMsg = msg
     *    }
     *   })
     * } catch(err) {
     *    // 发送失败
     *    tempMsg.status = 'sendFailed'
     * }
     *
     * // 如果发送失败，调用 resendMsg 重发消息
     * nim.msg.resendMsg({
     *   msg: tempMsg
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Resend a message
     * @locale
     */
    resendMsg(options: ResendMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 转发消息给其它用户。转发消息的消息是原消息的副本，其内部内容是一样的。
     *
     * #### 影响范围
     * - 消息接收方、以及发送方多端同步账号收到 {@link IMEventInterface.msg | msg} 事件
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @example
     * ```js
     * const prevMsg = await nim.msg.sendTextMsg({
     *  scene: 'p2p',
     *  to: 'test1',
     *  body: 'text'
     * })
     *
     * // 转发消息给 test2
     * const newMsg = await nim.msg.forwardMsg({
     *  msg: prevMsg,
     *  scene: 'p2p',
     *  to: 'test2'
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Forward the message
     * @locale
     */
    forwardMsg(options: ForwardMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 撤回消息
     *
     * - 撤回消息后，消息对于所有人都不可见
     * - 不能通过漫游消息、或者历史消息拉取到被撤回的消息
     *
     * #### 影响范围
     * - 接收方、以及发送方多端同步账号收到 `recallMsgP2p`、`recallMsgTeam`、`recallMsgSuperTeam` 系统通知
     * - 消息发送方，接收方、以及发送方多端同步账号收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%92%A4%E5%9B%9E%E6%B6%88%E6%81%AF.js" target="_blank">撤回消息</a></li>
     * </ul>
     *
     * @example
     * ```js
     * const msg = await nim.msg.sendTextMsg({
     *  scene: 'p2p',
     *  to: 'test1',
     *  body: 'text'
     * })
     *
     * // 撤回消息
     * const recalledMsg = await nim.msg.recallMsg({
     *   msg
     * })
     * @locale
     *
     * @locale en
     * Recall message
     *
     * The message receiver will receive system notification of the ' deleteMsg ' type,
     * If it is a group message, everyone in the group will receive this system notification.
     * If the same account is logged in on multiple devices at the same time, other devices will also receive this system notification.
     * @locale
     */
    recallMsg(options: RecallMsgOptions): Promise<IMMessage>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 单向删除消息
     *
     * - 单向删除仅影响当前账号能否看到消息，并不影响消息的其它参与者能否看到
     * - 若要双向删除消息，请使用 {@link MsgServiceInterface.recallMsg | recallMsg}
     * - 单向删除消息后，无法通过漫游消息、查询历史消息等方式得到消息
     *
     * #### 影响范围
     * - 该账号的多端登录实例会收到 {@link IMEventInterface.deleteSelfMsgs | deleteSelfMsgs} 事件
     * - 当前账号所有端收到 {@link IMEventInterface.updateSession | updateSession} 事件。session.lastMsg 变为 null
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E5%8D%95%E5%90%91%E5%88%A0%E9%99%A4%E6%B6%88%E6%81%AF.js" target="_blank">单向删除消息</a></li>
     * </ul>
     *
     * @locale
     *
     * @locale en
     * One-way deletion of messages
     *
     * Different from direct deletion of messages, after one-way deletion of messages, you cannot see the deleted messages, but the other party can still see them. In other words, only the messages on your side are deleted.
     *
     * If you log in to the same account on multiple devices at the same time, the current device and the other devices will receive a one-way deletion event.
     * @locale
     */
    deleteSelfMsgs(options: DeleteSelfMsgsOptions): Promise<DeleteSelfMsgsResult[]>;
    /**
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 发送 p2p 已读回执。
     *
     * - 注意，云信服务器并不会记录 p2p 会话中每一条消息是否已读。云信服务器实际记录的是会话最新的已读回执时间。因此，如果用户批量阅读多条消息，只需要发送最后一条消息的已读回执即可。
     *
     * #### 影响范围
     * - 发送成功后，原消息发送者收到 {@link IMEventInterface.updateSession}，以及 {@link IMEventInterface.msgReceipts} 事件通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E5%8D%95%E8%81%8A.js" target="_blank">已读回执-单聊</a></li>
     * </ul>
     *
     * @example
     * ```js
     * // 示例，收到消息后，立即发送已读回执
     * nim.on('msg', (msg) => {
     *    if (msg.scene === 'p2p') {
     *      nim.msg.sendMsgReceipt({
     *        msg: msg
     *      })
     *    }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Send message receipt for a message
     * @locale
     */
    sendMsgReceipt(options: SendMsgReceiptOptions): Promise<SendMsgReceiptResult | void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查看这条消息对方是否已读过。
     * 依赖 session 模块，需要使用 session.msgReceiptTime 属性和参数 msg.time 共同判定。
     * @locale
     *
     * @locale en
     * Check whether the other party has read the message.
     * Depending on the session module, you need to use the session.msgReceiptTime attribute and the msg.time parameter to determine whether the other party has read the message.
     * @locale
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送群信息的已读回执
     *
     * - 发送消息时，必须设置 `teamSpecializationInfo.needACK` 为 true，接收方才能够发送群已读回执
     * - 群已读回执是针对每条消息的回执记录。阅读多条消息时，应该调用接口设置每条消息的已读回执
     *
     * #### 影响范围
     * - 发送成功后，原消息发送者收到 {@link IMEventInterface.updateSession}，以及 {@link IMEventInterface.msgReceipts} 事件通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E7%BE%A4.js" target="_blank">已读回执-群</a></li>
     * </ul>
     *
     * ```js
     * // 示例，收到消息后，立即发送已读回执
     * nim.on('msg', (msg) => {
     *    if (msg.scene === 'team') {
     *      nim.msg.sendTeamMsgReceipt({
     *        teamMsgReceipts: [
     *            {
     *                idClient: msg.idClient,
     *                idServer: msg.idServer,
     *                teamId: msg.to
     *            }
     *        ]
     *      })
     *    }
     * })
     * ```
     * @locale
     *
     * @locale en
     * Send message receipt for a group message
     * @locale
     */
    sendTeamMsgReceipt(options: SendTeamMsgReceiptOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群消息已读/未读成员数量。该接口可以批量查询。
     *
     * - 仅当发送消息时，设置了 `teamSpecializationInfo.needACK` 为 true，才能获取到已读列表。否则对应消息的结果会在返回数组中被删掉
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E7%BE%A4.js" target="_blank">已读回执-群</a></li>
     * </ul>
     *
     * @example
     * ```js
     * const msg = await nim.msg.send({
     *  scene: "team",
     *  to: teamId,
     *  body: "text",
     *  teamSpecializationInfo: {
     *     needACK: true
     *   }
     * })
     *
     * const res = await nim.msg.getTeamMsgReads({
     *   // 参数为数组，可以批量查询
     *   teamMsgReceipts: [
     *    {
     *      teamId: msg.to,
     *      idClient: msg.idClient,
     *      idServer: msg.idServer
     *    }
     *  ]
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Get the number of persons who have read/unread the message.
     * @locale
     */
    getTeamMsgReads(options: GetTeamMsgReadsOptions): Promise<GetTeamMsgReadsResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群消息已读，以及未读账号列表。
     *
     * - 仅当发送消息时，设置 `teamSpecializationInfo.needACK` 为 true，才能获取到已读列表。否则会报 414 参数错误
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E7%BE%A4.js" target="_blank">已读回执-群</a></li>
     * </ul>
     *
     * @example
     * ```js
     * const msg = await nim.msg.send({
     *  scene: "team",
     *  to: teamId,
     *  body: "text",
     *  teamSpecializationInfo: {
     *     needACK: true
     *   }
     * })
     *
     * const res = await nim.msg.getTeamMsgReadAccounts({
     *   teamMsgReceipt: {
     *      teamId: msg.to,
     *      idClient: msg.idClient,
     *      idServer: msg.idServer
     *   }
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Get the accounts who have read/unread the message
     * @locale
     */
    getTeamMsgReadAccounts(options: GetTeamMsgReadAccountsOptions): Promise<GetTeamMsgReadAccountsResult>;
}
export declare enum EMsgType {
    text = 0,
    image = 1,
    audio = 2,
    video = 3,
    geo = 4,
    notification = 5,
    file = 6,
    tip = 10,
    robot = 11,
    g2 = 12,
    custom = 100
}
export declare type TMsgType = keyof typeof EMsgType;
export declare enum EMsgScene {
    p2p = 0,
    team = 1,
    superTeam = 5
}
/**
 * p2p: 单聊
 * team: 群聊
 * superTeam: 超大群聊
 */
export declare type TMsgScene = keyof typeof EMsgScene;
export declare enum EClientType {
    Android = 1,
    iOS = 2,
    PC = 4,
    WindowsPhone = 8,
    Web = 16,
    Server = 32,
    Mac = 64,
    HarmonyOS = 65
}
export declare type TClientType = keyof typeof EClientType;
export declare enum EMsgStatus {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到对方发送的消息，默认（己方未读）
     * @locale
     *
     * @locale en
     * Received the message sent by the other party. The message is unread by the receiver by default.
     * @locale
     */
    unread = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到对方发送的消息，己方已读
     * @locale
     *
     * @locale en
     * Received the message sent by the other party. The receiver has read it.
     * @locale
     */
    read = 2,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已删
     * @locale
     *
     * @locale en
     * Deleted
     * @locale
     */
    deleted = 3,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送中
     * @locale
     *
     * @locale en
     * Sending…
     * @locale
     */
    sending = 4,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送失败
     * 失败的情况可能又很多种，最常见于网络问题。
     * @locale
     *
     * @locale en
     * Sending failed.
     * Multiple situations will lead to failure. The most common causes are network problems.
     * @locale
     */
    sendFailed = 5,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已发送完毕
     * @locale
     *
     * @locale en
     * Sent
     * @locale
     */
    sent = 6,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 对方已读发送的内容
     * @locale
     *
     * @locale en
     * The other party has read the message.
     * @locale
     */
    receipt = 7,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被对方拒绝，比如被对方加入黑名单
     * @locale
     *
     * @locale en
     * Rejected by the other party for reasons such as being blocklisted by the other party.
     * @locale
     */
    refused = 10
}
export declare type TMsgStatus = keyof typeof EMsgStatus;
export interface IMMessage {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息的流向
     *
     * in 表示此消息是收到的消息
     * out 表示此消息是发出的消息
     * @locale
     *
     * @locale en
     * The flow of messages
     *
     * in: The message is a received one.
     * out: The message is an outgoing message. In other words, the message is sent out.
     * @locale
     */
    flow: 'in' | 'out';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 聊天对象, 账号或者群id
     * @locale
     *
     * @locale en
     * The person that the user chats with, account, or group ID
     * @locale
     */
    target: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息所属的会话的ID
     * @locale
     *
     * @locale en
     * ID of the conversation to which the message belongs
     * @locale
     */
    sessionId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息状态
     *
     * #### 发送消息状态
     * - sending: 发送中
     * - sent: 发送成功
     * - receipt: 发送成功且对方发送了已读回执
     * - deleted: 已删除
     * - sendFailed: 发送失败
     *
     * #### 接收消息状态
     * - unread: 收到对方发送的消息，消息未读
     * - read: 收到对方发送的消息，消息已读
     * - deleted: 已删除
     *
     * @locale
     *
     * @locale en
     * Message status
     *
     * #### send message status
     * - sending: The message is being sent
     * - sent: The message has been sent
     * - receipt: The message has been sent and has been read
     * - deleted: The message has been deleted
     * - sendFailed: The message failed to be sent.
     *
     * #### receive message status
     * - unread: Received the message sent by the other party, the message has not been read
     * - read: Received the message sent by the other party, the message has been read
     * - deleted: The message has been deleted
     *
     * @locale
     */
    status: TMsgStatus;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 场景（会话类型）
     * @locale
     *
     * @locale en
     * Scenario (conversation type)
     * @locale
     */
    scene: TMsgScene;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息接收方, 帐号或群id
     * @locale
     *
     * @locale en
     * Message recipient: account, or group ID
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息发送方, 帐号
     * @locale
     *
     * @locale en
     * Message sender: account
     * @locale
     */
    from: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送方的设备类型
     * @locale
     *
     * @locale en
     * Sender's device type
     * @locale
     */
    fromClientType?: TClientType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送端设备id
     * @locale
     *
     * @locale en
     * Sender device ID
     * @locale
     */
    fromDeviceId?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息发送方的昵称
     * @locale
     *
     * @locale en
     * The nickname of the sender of the message
     * @locale
     */
    fromNick?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息发送成功的时间戳(单位毫秒)
     * @locale
     *
     * @locale en
     * Timestamp when the message was sent successfully (unit: milliseconds)
     * @locale
     */
    time: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 用户最后更新时间
     * @locale
     *
     * @locale en
     * User’s last update time
     * @locale
     */
    userUpdateTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息类型
     * @locale
     *
     * @locale en
     * Message type
     * @locale
     */
    type: TMsgType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息的文本内容
     * @locale
     *
     * @locale en
     * Text content of the message
     * @locale
     */
    body: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附加消息
     *
     * 像是 file，geo 类型的消息，文本内容为空，在附加消息里会存在一个对象代表其内容
     * @locale
     *
     * @locale en
     * Additional message
     *
     * For file and geolocation messages, the text content is empty. Instead, there will be an object in the additional message to represent its content
     * @locale
     */
    attach?: StrAnyObj;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sdk 端测唯一标识，可做主键使用
     * @locale
     *
     * @locale en
     * Unique identifier of the message on the client side
     * @locale
     */
    idClient: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息服务器测的标识
     *
     * 它并不一定存在，故而这条消息的唯一标识请选用 idClient
     * @locale
     *
     * @locale en
     * Unique identifier of the message on the server side
     *
     * Because the identifier might not exist, please use idClient as the unique identifier of the message.
     * @locale
     */
    idServer?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务器第三方回调的扩展字段
     * @locale
     *
     * @locale en
     * Extension fields for server’s third-party callbacks
     * @locale
     */
    callbackExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 开发者自定义的消息子类型，格式为大于0的整数
     * @locale
     *
     * @locale en
     * Developer-defined message subtype (format: integer greater than 0)
     * @locale
     */
    subType?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知属性
     * @locale
     *
     * @locale en
     * Notification attributes
     * @locale
     */
    feature: TMsgFeature;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息的杂项设置
     * @locale
     *
     * @locale en
     * Miscellaneous settings for messages
     * @locale
     */
    setting?: TMsgSetting;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 反垃圾相关配置
     * @locale
     *
     * @locale en
     * Moderation configurations
     * @locale
     */
    antiSpamInfo?: TMsgAntiSpamInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送相关配置
     * @locale
     *
     * @locale en
     * Configurations related to push notifications
     * @locale
     */
    pushInfo?: TMsgPushInfo;
    /**
     * AI自动对话机器人消息
     */
    robotInfo?: {
        /**
         * 指定机器人具体功能，用户填写
         */
        function: string;
        /**
         * 指定话题，用户填写
         */
        topic: string;
        /**
         * 指定自定义内容，用户填写
         */
        customContent: string;
        /**
         * 指定机器人账号，用户填写。(仅在群聊中有效，p2p会被忽略)
         */
        account?: string;
    };
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群组特化的杂项配置
     * @locale
     *
     * @locale en
     * Configuration available only when the “scene” field is set to team or superTeam
     * @locale
     */
    teamSpecializationInfo?: TMsgTeamSpecializationInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * thread 消息的相关字段。假设消息的回复关系如下：
     * 消息A <- 消息B <- 消息C
     *
     * 则：消息C 的 replyMsg 是消息B，消息C 的 threadMsg 是消息A
     *
     * @locale
     *
     * @locale en
     * Fields related to threaded messages
     * Here is an example of a message that has been replied to many times: replyMsg of message C1 is message B1, and threadMsg of message C1 is message A
     *
     * message A
     * ｜ \
     * message B1 message B2
     * ｜
     * message C1
     * @locale
     */
    threadMessageInfo?: TMsgThreadMsgInfo;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * thread 消息的相关字段。
 * 这里举例回复了多次的消息：消息C1 的 replyMsg 是消息B1，消息C1 的 threadMsg 是消息A
 *
 * 消息A
 *  ｜   \
 * 消息B1  消息B2
 *  ｜
 * 消息C1
 * @locale
 *
 * @locale en
 * Fields related to threaded messages
 * Here is an example of a message that has been replied to many times: replyMsg of message C1 is message B1, and threadMsg of message C1 is message A
 *
 * message A
 * ｜ \
 * message B1 message B2
 * ｜
 * message C1
 * @locale
 */
export interface TMsgThreadMsgInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被回复消息的发送者账号
     * @locale
     *
     * @locale en
     * Account who sent replyMsg
     * @locale
     */
    replyMsgFromAccount?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被回复消息的接受者账号
     * @locale
     *
     * @locale en
     * Account who received replyMsg
     * @locale
     */
    replyMsgToAccount?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被回复消息的时间
     * @locale
     *
     * @locale en
     * Time when replyMsg was sent
     * @locale
     */
    replyMsgTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被回复消息的idServer
     * @locale
     *
     * @locale en
     * Message ID (generated by the IM server) of replyMsg
     * @locale
     */
    replyMsgIdServer?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被回复消息的idClient
     * @locale
     *
     * @locale en
     * Message ID (generated by the Client) of replyMsg
     * @locale
     */
    replyMsgIdClient?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * thread 消息的发送者账号
     * @locale
     *
     * @locale en
     * Account who sent threadMsg
     * @locale
     */
    threadMsgFromAccount?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * thread消息的接受者账号
     * @locale
     *
     * @locale en
     * Account who received threadMsg
     * @locale
     */
    threadMsgToAccount?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * thread消息的时间
     * @locale
     *
     * @locale en
     * Time when threadMsg was sent.
     * @locale
     */
    threadMsgTime?: number;
    threadMsgIdServer?: string;
    threadMsgIdClient?: string;
}
export declare enum EMsgFeature {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 默认
     * @locale
     *
     * @locale en
     * Default
     * @locale
     */
    default = 0,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 离线消息
     * @locale
     *
     * @locale en
     * Offline messages
     * @locale
     */
    leave = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 漫游消息
     *
     * @locale
     *
     * @locale en
     * Roaming messages
     * @locale
     */
    roam = 2
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步消息
     * @locale
     *
     * @locale en
     * Sync messages
     * @locale
     */
    /**
     * 透传消息
     */
}
export declare type TMsgFeature = keyof typeof EMsgFeature;
export interface TMsgTeamSpecializationInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群消息是否需要已读业务, 默认 false
     *
     * 注:
     * 1. 发送方在发送消息时这个字段若传 true
     * 2. 那么接收方可以调用 sendTeamMsgReceipt 来标识消息 receipt 已读。
     * 3. 发送方就会接到事件 teamMsgReceipts 代表接收方已读了发送方的消息.
     * @locale
     *
     * @locale en
     * Whether the group messages need message receipts (message read or unread).
     * @locale
     */
    needACK?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否已经发送群消息已读回执。（端测维护此字段）
     * 若调用 sendTeamMsgReceipt，会对此消息的 teamSpecializationInfo.isACKSent 标记为 true。
     *
     * 注：当 db 开启才能生效
     * @locale
     *
     * @locale en
     * Whether the read receipts for group messages have been sent. (the application side maintains this field)
     * If sendTeamMsgReceipt is called, teamSpecializationInfo.isACKSent of this message will be marked as true.
     *
     * Note: Not supported currently.
     * @locale
     */
    isACKSent: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群已读消息快照大小(即消息发送时的群人数-1)
     * @locale
     *
     * @locale en
     * Snapshot size of group messages that have been read (that is, the result of “the number of group members at the time when the message is sent” minus “1”)
     * @locale
     */
    ackSnapshot: number;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 推送相关配置
 * @locale
 *
 * @locale en
 * Push notification related configurations
 * @locale
 */
export interface TMsgPushInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要推送。p2p会话默认为 true，群会话默认为 false
     * @locale
     *
     * @locale en
     * Whether push notifications is required  107
     * @locale
     */
    needPush?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否要做消息计数（推送消息后的 app 角标）
     * @locale
     *
     * @locale en
     * Whether to do message count (app corner mark that appears after messages are pushed) 109
     * @locale
     */
    needPushBadge?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 需要推送昵称。默认为是
     * @locale
     *
     * @locale en
     * Need to push nickname // 110
     * @locale
     */
    needPushNick?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 第三方自定义的推送属性，长度2048。具体内容请参考文档：[推送payload配置](https://doc.yunxin.163.com/messaging/docs/DQyNjc5NjE?platform=server)
     *
     * @example
     * ```js
     * nim.sendTextMsg({
     *    scene: 'p2p',
     *    to: 'test',
     *    body: 'message',
     *    pushInfo: {
     *        pushPayload: JSON.stringify({
     *            // 小米推送配置；注意，小米的推送字段不需要加 xiaomiField, xmField 前缀
     *            notify_foreground: 1
     *            // 华为推送配置
     *            hwField: {
     *              click_action: {}
     *            }
     *        })
     *    }
     * })
     * ```
     * @locale
     *
     * @locale en
     * Attributes of third-party custom push notifications (length: 2048 bytes)
     * @locale
     */
    pushPayload?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送文本。若不填，则消息的 body 字段会作为默认推送文本
     * @locale
     *
     * @locale en
     * Push text
     * @locale
     */
    pushContent?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群组消息强推开关，默认 false
     *
     * - 当用户设置群消息免打扰 {@link TeamServiceInterface.updateMyMemberInfo | (updateMyMemberInfo#bitConfigMask)} 时，可以通过强推将消息推送给用户
     * - 常用使用场景为 at 群成员时，使用强推将消息定向推给群内成员
     * @locale
     *
     * @locale en
     * Whether to force push group messages. The default value is false, representing that the group messages will not be force pushed to members. You can set it to true.
     * @locale
     */
    needForcePush?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 强推的成员账号。
     *
     * - 如不设置，则该参数默认为推送群内所有人，即等效于 "#%@all@%#"
     * - 注意该参数为string，例：'["id1", "id2"]'
     * @locale
     *
     * @locale en
     * Accounts of group members to whom group messages need to be force pushed.
     *
     * Example: '["id1", "id2"]'
     * Note: If you want group messages to be force pushed to all group members, set this parameter to "#%@all@%#"
     * @locale
     */
    forcePushIDsList?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 强推文本（可扩展为区别与普通推送的推送文本），长度限制 150 字符
     * @locale
     *
     * @locale en
     * Text of the group messages that are force pushed to group members (can be customized to be different from normal push text). The length is limited to 150 characters.
     * @locale
     *
     */
    forcePushContent?: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 反垃圾相关配置
 * @locale
 *
 * @locale en
 * Anti-spam related configurations
 * @locale
 */
export interface TMsgAntiSpamInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * (功能暂时不开放)是否需要使用自定义反垃圾字段 antiSpamContent, 缺省false
     * 注：此字段与 antiSpamContent 联合起来使用
     * @locale
     *
     * @locale en
     * (The function is temporarily unavailable) Whether you need to use the custom anti-spam field antiSpamContent (default value: false)
     * Note: If you set the needAntiSpam field, you must set the antiSpamContent field also.
     * @locale
     */
    needAntiSpam?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 开发者自定义的反垃圾字段，长度限制 5000。格式如 '{"type":1,"data":"YOUR_DATA_KEY"}'
     * @locale
     *
     * @locale en
     * Developer-defined anti-spam field, the length is limited to 5,000 bytes. Format example: '{"type":1,"data":"YOUR_DATA_KEY"}'
     * @locale
     */
    antiSpamContent?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 用户配置的对某些单条消息另外的反垃圾的业务ID
     * @locale
     *
     * @locale en
     * User-configured additional anti-spam service IDs for some messages
     * @locale
     */
    antiSpamBIZID?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否命中客户端反垃圾
     * @locale
     *
     * @locale en
     * Whether spam is detected
     * @locale
     */
    clientAntispamHitting?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 单条消息是否使用易盾反垃圾。
     * 默认 0: (在开通易盾的情况下)不过易盾反垃圾。
     * 其他值都是按照原来的规则
     * @locale
     *
     * @locale en
     * Whether to use GuardEase anti-spam for a message.
     * Default 0: Use Client anti-spam in the case of GuardEase having been activated)
     * Other values follow the original rules
     * @locale
     */
    antiSpamUsingYidun?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 易盾check的回调URL，目前仅支持Audio类型的消息，最长256个字符，如果不合法则忽略该参数
     * @locale
     *
     * @locale en
     * The callback URL that GuardEase checks. Currently, only messages (up to 256 characters) of the “Audio” type are supported. If the field is invalid, it will not take effect.
     * @locale
     */
    yidunCallbackURL?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 易盾反垃圾增强反作弊专属字段, 限定使用 JSON 序列化字符串，长度限制1024
     * @locale
     *
     * @locale en
     * GuardEase’s exclusive field for enhanced anti-cheating (format: JSON serialized string, length limit: 1,024 bytes).
     * @locale
     */
    yidunAntiCheating?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 易盾反垃圾扩展字段，限制json，长度限制1024
     * @locale
     *
     * @locale en
     * GuardEase anti-spam extension field (format: JSON , length limit 1,024 bytes)
     * @locale
     */
    yidunAntiSpamExtension?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 易盾反垃圾返回的结果字段。
     * 若开启了易盾反垃圾，并且针对文本或图片如果被反垃圾策略匹配中，端测会透传此反垃圾结果字段返回。
     * 格式为 JSON 序列化的字符串
     * @locale
     *
     * @locale en
     * The result field returned by GuardEase Anti-Spam .
     * When GuardEase anti-spam is enabled and spams on the texts or images are detected, the application side will transparently transmit this anti-spam result field and return it.
     * formatted as JSON serialized string
     * @locale
     */
    yidunAntiSpamResult?: string;
}
export interface TMsgSetting {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否为重发的消息
     * @locale
     *
     * @locale en
     * Whether it is resent
     * @locale
     */
    resendFlag?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * (可选) 指向自定义抄送的配置
     * @locale
     *
     * @locale en
     * (optional) custom data sync configuration
     * @locale
     */
    envConfig?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存云端消息历史，缺省则 true
     * @locale
     *
     * @locale en
     * Whether to store historical messages on the cloud (default value: true)
     * @locale
     */
    needSaveHistory?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该消息是否支持漫游 缺省则 true
     * @locale
     *
     * @locale en
     * Whether the message supports roaming (default value: true)
     * @locale
     */
    needRoaming?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否支持离线消息，缺省则 true
     * @locale
     *
     * @locale en
     * Whether to support offline messages (default value: true)
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该消息是否支持发送者多端同步
     * @locale
     *
     * @locale en
     * Whether the message supports multi-device synchronization for the sender
     * @locale
     */
    needSelfSync?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否要抄送
     * @locale
     *
     * @locale en
     * Whether the server’s conversation list needs to be refreshed (0: No, 1: Yes; default value: 1; this parameter will be determined only when offline messages are stored).
     * @locale
     */
    needRouted?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要刷新服务器会话列表，0:否，1:是；只有消息存离线的情况下，才会判断该参数，缺省：1
     * @locale
     *
     * @locale en
     * Whether the message should be muted on the recipient side. This field is returned by the server, and it does not need to be set on the application side.
     * @locale
     */
    needUpdateSession?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该消息在接收方是否应该被静音。此字段服务器返回，端测不需要自己设置
     * @locale
     *
     * @locale en
     * Whether the message should be muted on the recipient side. This field is returned by the server, and it does not need to be set on the application side.
     * @locale
     */
    isMuted?: boolean;
}
export interface ForwardMsgOptions {
    /**
     * 会话场景
     *
     * - p2p: 单聊
     * - team: 群聊
     * - superTeam: 超大群聊
     */
    scene: TMsgScene;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 转发的目标，账号或者群id
     * @locale
     *
     * @locale en
     * Forwarding target: account or group ID
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 待转发的消息对象
     * @locale
     *
     * @locale en
     * The message object to be forwarded
     * @locale
     */
    msg: IMMessage;
}
export interface ResendMsgOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 请传入完整的消息对象
     * @locale
     *
     * @locale en
     * Please pass in the complete message object
     * @locale
     */
    msg: IMMessage;
}
export interface RecallMsgOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要撤回的消息对象
     * @locale
     *
     * @locale en
     * The message object to be recalled
     * @locale
     */
    msg: IMMessage;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 撤回消息是否需要发送推送。
     *
     * - 若需要发送推送，则需要设置 `pushInfo.needPush = true`，且必须设置 `pushInfo.pushContent`
     * - 发送推送会将原消息推送内容替换为撤回消息的推送
     * @locale
     *
     * @locale en
     * Configurations related to push notifications
     * @locale
     */
    pushInfo?: TSysMsgPushInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 撤回消息时的附言。
     *
     * 收到类型为 `recallMsgP2p`, `recallMsgTeam`, `recallMsgSuperTeam`系统通知时，通过 `sysMsg.content` 读取撤回消息时发送的 `ps` 属性
     * @locale
     *
     * @locale en
     * Personal message
     * @locale
     */
    ps?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附加信息，推荐使用 JSON 格式化字符串。
     *
     * 收到类型为 `recallMsgP2p`, `recallMsgTeam`, `recallMsgSuperTeam`系统通知时，通过 `sysMsg.attach` 读取撤回消息时发送的 `attach` 属性
     * @locale
     *
     * @locale en
     * Additional information, JSON formatted string is recommended
     * @locale
     */
    attach?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 抄送环境
     * @locale
     *
     * @locale en
     * Data synchronization environment
     * @locale
     */
    env?: string;
}
export interface DeleteSelfMsgsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 待删除的消息对象
     * @locale
     *
     * @locale en
     * The message object to be deleted
     * @locale
     */
    msgs: IMMessage[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段。该字段会在多端回调的事件通知中出现 {@link IMEventInterface.deleteSelfMsgs | deleteSelfMsgs}
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext?: string;
}
export interface DeleteSelfMsgsResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除时间
     * @locale
     *
     * @locale en
     * Deletion time
     * @locale
     */
    deletedTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的发送者
     * @locale
     *
     * @locale en
     * Sender of the message
     * @locale
     */
    from: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的 idClient
     * @locale
     *
     * @locale en
     * idClient of the message
     * @locale
     */
    idClient: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的 idServer
     * @locale
     *
     * @locale en
     * idServer of the message
     * @locale
     */
    idServer: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的场景，只有 p2p, team ，超大群暂时不允许单向删除
     * @locale
     *
     * @locale en
     * The message is only allowed to be one-way deleted in one-to-one chat and group chat (normal group). One-way deletion is not allowed in super groups.
     * @locale
     */
    scene: 'p2p' | 'team';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的发送时间
     * @locale
     *
     * @locale en
     * When this message was sent
     * @locale
     */
    time: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此消息的接收者
     * @locale
     *
     * @locale en
     * Recipient of this message
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * Extended field
     * @locale
     */
    ext?: string | null;
}
export interface SendMsgReceiptOptions {
    msg: IMMessage;
}
export interface SendMsgReceiptResult {
    to: string;
    idClient: string;
    time: number;
}
export interface SendTeamMsgReceiptOptions {
    teamMsgReceipts: NIMETeamMsgReceiptsQueryOptions[];
}
export interface GetTeamMsgReadsOptions {
    /**
     * @example
     * ```js
     * const res = await nim.msg.getTeamMsgReads({
     *   // 参数为数组，可以批量查询
     *   teamMsgReceipts: [
     *    {
     *      teamId: msg.to,
     *      idClient: msg.idClient,
     *      idServer: msg.idServer
     *    }
     *  ]
     * })
     * ```
     */
    teamMsgReceipts: NIMETeamMsgReceiptsQueryOptions[];
}
export interface GetTeamMsgReadAccountsOptions {
    /**
     * 获取群消息已读回执的属性
     *
     * @example
     * ```js
     * const res = await nim.msg.getTeamMsgReadAccounts({
     *   teamMsgReceipt: {
     *      teamId: msg.to,
     *      idClient: msg.idClient,
     *      idServer: msg.idServer
     *   }
     * })
     * ```
     */
    teamMsgReceipt: NIMETeamMsgReceiptsQueryOptions;
}
export interface NIMETeamMsgReceiptsQueryOptions {
    /**
     * 群id
     */
    teamId: string;
    idServer: string;
    idClient: string;
}
/**
 * 批量获取群消息已读账户数量
 *
 * - teamId: 群id
 * - idServer: 消息的 idServer
 * - idClient: 消息的 idClient
 * - read: 已读成员数量
 * - unread: 未读成员数量
 */
export declare type GetTeamMsgReadsResult = {
    teamId: string;
    idServer: string;
    idClient: string;
    read: number;
    unread: number;
}[];
export interface GetTeamMsgReadAccountsResult {
    /**
     * 已读成员的数组
     */
    readAccounts: string[];
    /**
     * 群消息基本信息
     */
    teamMsgReceipt: {
        teamId: string;
        idClient: string;
    };
    /**
     * 未读成员的数组
     */
    unreadAccounts: string[];
}
export interface TeamMsgReceipt {
    teamId: string;
    idServer: string;
    read: number;
    unread: number;
    idClient: string;
    account: string;
}
export interface p2pMsgReceipt {
    sessionId: string;
    idClient: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务器回包的receipt时间
     * @locale
     *
     * @locale en
     * @locale
     */
    msgReceiptTime: number;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 广播消息定义
 * @locale
 *
 * @locale en
 * Definition of broadcast messages
 * @locale
 */
export interface NIM_BroadcastMessage {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息内容
     * @locale
     *
     * @locale en
     * Body of a message
     * @locale
     */
    body: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息时间戳
     * @locale
     *
     * @locale en
     * message timestamp
     * @locale
     */
    time: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 广播消息 id
     * @locale
     *
     * @locale en
     * Broadcast message ID
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该消息的发送者账号（account id）
     * @locale
     *
     * @locale en
     * The account of the sender
     * @locale
     */
    fromAccid: string;
}
