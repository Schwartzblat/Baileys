import type KeyedDB from '@adiwajshing/keyed-db'
import type { Comparable } from '@adiwajshing/keyed-db/lib/Types'
import type { Logger } from 'pino'
import { proto } from '../../WAProto'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type makeLegacySocket from '../LegacySocket'
import type makeMDSocket from '../Socket'
import type { BaileysEventEmitter, Chat, ConnectionState, Contact, GroupMetadata, MessageInfo, PresenceData, WAMessage, WAMessageCursor, WAMessageKey } from '../Types'
import { toNumber } from '../Utils'
import { jidNormalizedUser } from '../WABinary'
import makeOrderedDictionary from './make-ordered-dictionary'

type LegacyWASocket = ReturnType<typeof makeLegacySocket>
type AnyWASocket = ReturnType<typeof makeMDSocket>

export const waChatKey = (pin: boolean) => ({
	key: (c: Chat) => (pin ? (c.pin ? '1' : '0') : '') + (c.archive ? '0' : '1') + c.conversationTimestamp.toString(16).padStart(8, '0') + c.id,
	compare: (k1: string, k2: string) => k2.localeCompare (k1)
})

export const waMessageID = (m: WAMessage) => m.key.id

export type BaileysInMemoryStoreConfig = {
	chatKey?: Comparable<Chat, string>
	logger?: Logger
}

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)

export default (
	{ logger, chatKey }: BaileysInMemoryStoreConfig
) => {
	logger = logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' })
	chatKey = chatKey || waChatKey(true)
	const KeyedDB = require('@adiwajshing/keyed-db').default as new (...args: any[]) => KeyedDB<Chat, string>
	
	const chats = new KeyedDB(chatKey, c => c.id)
	const messages: { [_: string]: ReturnType<typeof makeMessagesDictionary> } = { }
	const contacts: { [_: string]: Contact } = { }
	const groupMetadata: { [_: string]: GroupMetadata } = { }
	const messageInfos: { [id: string]: MessageInfo } = { }
	const presences: { [id: string]: { [participant: string]: PresenceData } } = { }
	const state: ConnectionState = { connection: 'close' }

	const assertMessageList = (jid: string) => {
		if(!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}

		return messages[jid]
	}

	const contactsUpsert = (newContacts: Contact[]) => {
		const oldContacts = new Set(Object.keys(contacts))
		for(const contact of newContacts) {
			oldContacts.delete(contact.id)
			contacts[contact.id] = Object.assign(
				contacts[contact.id] || {}, 
				contact
			)
		}

		return oldContacts
	}

	/**
	 * binds to a BaileysEventEmitter. 
	 * It listens to all events and constructs a state that you can query accurate data from.
	 * Eg. can use the store to fetch chats, contacts, messages etc.
	 * @param ev typically the event emitter from the socket connection
	 */
	const bind = (ev: BaileysEventEmitter) => {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})
		ev.on('chats.set', ({ chats: newChats, isLatest }) => {
			if(isLatest) {
				chats.clear()
			}
			
			const chatsAdded = chats.insertIfAbsent(...newChats).length
			logger.debug({ chatsAdded }, 'synced chats')
		})
		ev.on('contacts.set', ({ contacts: newContacts }) => {
			const oldContacts = contactsUpsert(newContacts)
			for(const jid of oldContacts) {
				delete contacts[jid]
			}

			logger.debug({ deletedContacts: oldContacts.size, newContacts }, 'synced contacts')
		})
		ev.on('messages.set', ({ messages: newMessages, isLatest }) => {
			if(isLatest) {
				for(const id in messages) {
					delete messages[id]
				}
			}

			for(const msg of newMessages) {
				const jid = msg.key.remoteJid!
				const list = assertMessageList(jid)
				list.upsert(msg, 'prepend')
			}

			logger.debug({ messages: newMessages.length }, 'synced messages')
		})
		ev.on('contacts.update', updates => {
			for(const update of updates) {
				if(contacts[update.id!]) {
					Object.assign(contacts[update.id!], update)
				} else {
					logger.debug({ update }, 'got update for non-existant contact')
				}
			}
		})
		ev.on('chats.upsert', newChats => {
			chats.upsert(...newChats)
		})
		ev.on('chats.update', updates => {
			for(const update of updates) {
				const result = chats.update(update.id!, chat => {
					if(update.unreadCount > 0) {
						update.unreadCount = chat.unreadCount + update.unreadCount
					}

					Object.assign(chat, update)
				})
				if(!result) {
					logger.debug({ update }, 'got update for non-existant chat')
				}
			}
		})
		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id], update)
		})
		ev.on('chats.delete', deletions => {
			for(const item of deletions) {
				chats.deleteById(item)
			}
		})
		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			switch (type) {
			case 'append':
			case 'notify':
				for(const msg of newMessages) {
					const jid = jidNormalizedUser(msg.key.remoteJid!)
					const list = assertMessageList(jid)
					list.upsert(msg, 'append')

					if(type === 'notify') {
						if(!chats.get(jid)) {
							ev.emit('chats.upsert', [ 
								{ 
									id: jid, 
									conversationTimestamp: toNumber(msg.messageTimestamp), 
									unreadCount: 1 
								} 
							])
						}

						// add message infos if required
						messageInfos[msg.key.id!] = messageInfos[msg.key.id!] || { reads: {}, deliveries: {} }
					}
				}

				break
			}
		})
		ev.on('messages.update', updates => {
			for(const { update, key } of updates) {
				const list = assertMessageList(key.remoteJid)
				const result = list.updateAssign(key.id, update)
				if(!result) {
					logger.debug({ update }, 'got update for non-existent message')
				}
			}
		})
		ev.on('messages.delete', item => {
			if('all' in item) {
				const list = messages[item.jid]
				list?.clear()
			} else {
				const jid = item.keys[0].remoteJid
				const list = messages[jid]
				if(list) {
					const idSet = new Set(item.keys.map(k => k.id))
					list.filter(m => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.update', updates => {
			for(const update of updates) {
				if(groupMetadata[update.id]) {
					Object.assign(groupMetadata[update.id!], update)
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if(metadata) {
				switch (action) {
				case 'add':
					metadata.participants.push(...participants.map(id => ({ id, isAdmin: false, isSuperAdmin: false })))
					break
				case 'demote':
				case 'promote':
					for(const participant of metadata.participants) {
						if(participants.includes(participant.id)) {
							participant.isAdmin = action === 'promote'
						}
					}

					break
				case 'remove':
					metadata.participants = metadata.participants.filter(p => !participants.includes(p.id))
					break
				}
			}
		})

		ev.on('message-info.update', updates => {
			for(const { key, update } of updates) {
				const obj = messageInfos[key.id!]
				if(obj) {
					// add reads/deliveries
					for(const key in update) {
						Object.assign(obj[key], update[key])
					}
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages
	})

	const fromJSON = (json: { chats: Chat[], contacts: { [id: string]: Contact }, messages: { [id: string]: WAMessage[] } }) => {
		chats.upsert(...json.chats)
		contactsUpsert(Object.values(contacts))
		for(const jid in json.messages) {
			const list = assertMessageList(jid)
			for(const msg of json.messages[jid]) {
				list.upsert(proto.WebMessageInfo.fromObject(msg), 'append')
			}
		}
	}


	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		messageInfos,
		state,
		presences,
		bind,
		loadMessages: async(jid: string, count: number, cursor: WAMessageCursor, sock: LegacyWASocket | undefined) => {
			const list = assertMessageList(jid)
			const retrieve = async(count: number, cursor: WAMessageCursor) => {
				const result = await sock?.fetchMessagesFromWA(jid, count, cursor)
				return result || []
			}

			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = !!cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined
			
			let messages: WAMessage[]
			if(list && mode === 'before' && (!cursorKey || cursorValue)) {
				if(cursorValue) {
					const msgIdx = list.array.findIndex(m => m.key.id === cursorKey.id)
					messages = list.array.slice(0, msgIdx)
				} else {
					messages = list.array
				}

				const diff = count - messages.length
				if(diff < 0) {
					messages = messages.slice(-count) // get the last X messages
				} else if(diff > 0) {
					const [fMessage] = messages
					const cursor = { before: fMessage?.key || cursorKey }
					const extra = await retrieve (diff, cursor)
					// add to DB
					for(let i = extra.length-1; i >= 0;i--) {
						list.upsert(extra[i], 'prepend')
					}

					messages.splice(0, 0, ...extra)
				}
			} else {
				messages = await retrieve(count, cursor)
			}

			return messages
		},
		loadMessage: async(jid: string, id: string, sock: LegacyWASocket | undefined) => {
			let message = messages[jid]?.get(id)
			if(!message) {
				message = await sock?.loadMessageFromWA(jid, id)
			}

			return message
		},
		mostRecentMessage: async(jid: string, sock: LegacyWASocket | undefined) => {
			let message = messages[jid]?.array.slice(-1)[0]
			if(!message) {
				const [result] = await sock?.fetchMessagesFromWA(jid, 1, undefined)
				message = result
			}

			return message
		},
		fetchImageUrl: async(jid: string, sock: AnyWASocket | undefined) => {
			const contact = contacts[jid]
			if(!contact) {
				return sock?.profilePictureUrl(jid)
			}

			if(typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(jid)
			}

			return contact.imgUrl
		},
		fetchGroupMetadata: async(jid: string, sock: AnyWASocket | undefined) => {
			if(!groupMetadata[jid]) {
				groupMetadata[jid] = await sock?.groupMetadata(jid)
			}

			return groupMetadata[jid]
		},
		fetchBroadcastListInfo: async(jid: string, sock: LegacyWASocket | undefined) => {
			if(!groupMetadata[jid]) {
				groupMetadata[jid] = await sock?.getBroadcastListInfo(jid)
			}

			return groupMetadata[jid]
		},
		fetchMessageInfo: async({ remoteJid, id }: WAMessageKey, sock: LegacyWASocket | undefined) => {
			if(!messageInfos[id!]) {
				messageInfos[id!] = await sock?.messageInfo(remoteJid, id)
			}

			return messageInfos[id!]
		},
		toJSON,
		fromJSON,
		writeToFile: (path: string) => {
			// require fs here so that in case "fs" is not available -- the app does not crash
			const { writeFileSync } = require('fs')
			writeFileSync(path, JSON.stringify(toJSON()))
		},
		readFromFile: (path: string) => {
			// require fs here so that in case "fs" is not available -- the app does not crash
			const { readFileSync, existsSync } = require('fs')
			if(existsSync(path)) {
				logger.debug({ path }, 'reading from file')
				const jsonStr = readFileSync(path, { encoding: 'utf-8' })
				const json = JSON.parse(jsonStr)
				fromJSON(json)
			}
		}
	}
}