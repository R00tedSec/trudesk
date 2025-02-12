/*
 *       .                             .o8                     oooo
 *    .o8                             "888                     `888
 *  .o888oo oooo d8b oooo  oooo   .oooo888   .ooooo.   .oooo.o  888  oooo
 *    888   `888""8P `888  `888  d88' `888  d88' `88b d88(  "8  888 .8P'
 *    888    888      888   888  888   888  888ooo888 `"Y88b.   888888.
 *    888 .  888      888   888  888   888  888    .o o.  )88b  888 `88b.
 *    "888" d888b     `V88V"V8P' `Y8bod88P" `Y8bod8P' 8""888P' o888o o888o
 *  ========================================================================
 *  Author:     Chris Brame
 *  Updated:    1/20/19 4:43 PM
 *  Copyright (c) 2014-2019. All rights reserved.
 */

var _ = require('lodash')
var path = require('path')
var async = require('async')
var winston = require('../logger')
var emitter = require('../emitter')
var util = require('../helpers/utils')
var templateSchema = require('../models/template')
var ticketSchema = require('../models/ticket')
var userSchema = require('../models/user')
var departmentSchema = require('../models/department')
var NotificationSchema = require('../models/notification')
var settingsSchema = require('../models/setting')
var Email = require('email-templates')
var templateDir = path.resolve(__dirname, '..', 'mailer', 'templates')
var permissions = require('../permissions')

var socketUtils = require('../helpers/utils')
var sharedVars = require('../socketio/index').shared

var notifications = require('../notifications') // Load Push Events

var eventTicketCreated = require('./events/event_ticket_created')

;(function () {
  notifications.init(emitter)

  emitter.on('ticket:created', async function (data) {
    await eventTicketCreated(data)
  })

  function sendPushNotification (tpsObj, data) {
    var tpsEnabled = tpsObj.tpsEnabled
    var tpsUsername = tpsObj.tpsUsername
    var tpsApiKey = tpsObj.tpsApiKey
    var hostname = tpsObj.hostname
    var ticket = data.ticket
    var message = data.message

    if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
      winston.debug('Warn: TPS - Push Service Not Enabled')
      return
    }

    if (!hostname) {
      winston.debug('Could not get hostname for push: ' + data.type)
      return
    }

    // Data
    // 1 - Ticket Created
    // 2 - Ticket Comment Added
    // 3 - Ticket Note Added
    // 4 - Ticket Assignee Set
    //  - Message
    var title
    var users = []
    var content
    switch (data.type) {
      case 1:
        title = 'Ticket #' + ticket.uid + ' Created'
        content = ticket.owner.fullname + ' submitted a ticket'
        users = _.map(ticket.group.sendMailTo, function (o) {
          return o._id
        })
        break
      case 2:
        title = 'Ticket #' + ticket.uid + ' Updated'
        content = _.last(ticket.history).description
        var comment = _.last(ticket.comments)
        users = _.compact(
          _.map(ticket.subscribers, function (o) {
            if (comment.owner._id.toString() !== o._id.toString()) {
              return o._id
            }
          })
        )
        break
      case 3:
        title = message.owner.fullname + ' sent you a message'
        break
      case 4:
        var assigneeId = data.assigneeId
        var ticketUid = data.ticketUid
        ticket = {}
        ticket._id = data.ticketId
        ticket.uid = data.ticketUid
        title = 'Assigned to Ticket #' + ticketUid
        content = 'You were assigned to Ticket #' + ticketUid
        users = [assigneeId]
        break
      default:
        title = ''
    }

    if (_.size(users) < 1) {
      winston.debug('No users to push too | UserSize: ' + _.size(users))
      return
    }

    var n = {
      title: title,
      data: {
        ticketId: ticket._id,
        ticketUid: ticket.uid,
        users: users,
        hostname: hostname
      }
    }

    if (content) {
      n.content = content
    }

    notifications.pushNotification(tpsUsername, tpsApiKey, n)
  }

  emitter.on('ticket:updated', function (ticket) {
    io.sockets.emit('$trudesk:client:ticket:updated', { ticket: ticket })
  })

  emitter.on('ticket:deleted', function (oId) {
    io.sockets.emit('ticket:delete', oId)
    io.sockets.emit('$trudesk:client:ticket:deleted', oId)
  })

  emitter.on('ticket:subscriber:update', function (data) {
    io.sockets.emit('ticket:subscriber:update', data)
  })

  emitter.on('ticket:comment:added', function (ticket, comment, hostname) {
    // Goes to client
    io.sockets.emit('updateComments', ticket)

    settingsSchema.getSettingsByName(['tps:enable', 'tps:username', 'tps:apikey', 'mailer:enable'], function (
      err,
      tpsSettings
    ) {
      if (err) return false

      var tpsEnabled = _.head(_.filter(tpsSettings, ['name', 'tps:enable']))
      var tpsUsername = _.head(_.filter(tpsSettings, ['name', 'tps:username']))
      var tpsApiKey = _.head(_.filter(tpsSettings), ['name', 'tps:apikey'])
      var mailerEnabled = _.head(_.filter(tpsSettings), ['name', 'mailer:enable'])
      mailerEnabled = !mailerEnabled ? false : mailerEnabled.value

      if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
        tpsEnabled = false
      } else {
        tpsEnabled = tpsEnabled.value
        tpsUsername = tpsUsername.value
        tpsApiKey = tpsApiKey.value
      }

      async.parallel(
        [
          function (cb) {
            if (ticket.owner._id.toString() === comment.owner.toString()) return cb
            if (!_.isUndefined(ticket.assignee) && ticket.assignee._id.toString() === comment.owner.toString())
              return cb

            var notification = new NotificationSchema({
              owner: ticket.owner,
              title: 'Comment Added to Ticket#' + ticket.uid,
              message: ticket.subject,
              type: 1,
              data: { ticket: ticket },
              unread: true
            })

            notification.save(function (err) {
              return cb(err)
            })
          },
          function (cb) {
            if (_.isUndefined(ticket.assignee)) return cb()
            if (ticket.assignee._id.toString() === comment.owner.toString()) return cb
            if (ticket.owner._id.toString() === ticket.assignee._id.toString()) return cb()

            var notification = new NotificationSchema({
              owner: ticket.assignee,
              title: 'Comment Added to Ticket#' + ticket.uid,
              message: ticket.subject,
              type: 2,
              data: { ticket: ticket },
              unread: true
            })

            notification.save(function (err) {
              return cb(err)
            })
          },
          function (cb) {
            sendPushNotification(
              {
                tpsEnabled: tpsEnabled,
                tpsUsername: tpsUsername,
                tpsApiKey: tpsApiKey,
                hostname: hostname
              },
              { type: 2, ticket: ticket }
            )
            return cb()
          },
          // Send email to subscribed users
          function (c) {
            if (!mailerEnabled) return c()

            var mailer = require('../mailer')
            var emails = []
            async.each(
              ticket.subscribers,
              function (member, cb) {
                if (_.isUndefined(member) || _.isUndefined(member.email)) return cb()
                if (member._id.toString() === comment.owner.toString()) return cb()
                if (member.deleted) return cb()

                emails.push(member.email)

                cb()
              },
              function (err) {
                if (err) return c(err)

                emails = _.uniq(emails)

                if (_.size(emails) < 1) {
                  return c()
                }

                var email = new Email({
                  views: {
                    root: templateDir,
                    options: {
                      extension: 'handlebars'
                    }
                  }
                })

                ticket.populate('comments.owner', function (err, ticket) {
                  if (err) winston.warn(err)
                  if (err) return c()

                  ticket = ticket.toJSON()

                  email
                    .render('ticket-comment-added', {
                      ticket: ticket,
                      comment: comment
                    })
                    .then(function (html) {
                      var mailOptions = {
                        to: emails.join(),
                        subject: 'Updated: Ticket #' + ticket.uid + '-' + ticket.subject,
                        html: html,
                        generateTextFromHTML: true
                      }

                      mailer.sendMail(mailOptions, function (err) {
                        if (err) winston.warn('[trudesk:events:sendSubscriberEmail] - ' + err)

                        winston.debug('Sent [' + emails.length + '] emails.')
                      })

                      return c()
                    })
                    .catch(function (err) {
                      winston.warn('[trudesk:events:sendSubscriberEmail] - ' + err)
                      return c(err)
                    })
                })
              }
            )
          }
        ],
        function () {
          // Blank
        }
      )
    })
  })

  emitter.on('ticket:setAssignee', function (data) {
    settingsSchema.getSettingsByName(['tps:enable', 'tps:username', 'tps:apikey'], function (err, tpsSettings) {
      if (err) return false

      var tpsEnabled = _.head(_.filter(tpsSettings, ['name', 'tps:enable']))
      var tpsUsername = _.head(_.filter(tpsSettings, ['name', 'tps:username']))
      var tpsApiKey = _.head(_.filter(tpsSettings), ['name', 'tps:apikey'])

      if (!tpsEnabled || !tpsUsername || !tpsApiKey) {
        tpsEnabled = false
      } else {
        tpsEnabled = tpsEnabled.value
        tpsUsername = tpsUsername.value
        tpsApiKey = tpsApiKey.value
      }

      if (!tpsEnabled) return

      sendPushNotification(
        {
          tpsEnabled: tpsEnabled,
          tpsUsername: tpsUsername,
          tpsApiKey: tpsApiKey,
          hostname: data.hostname
        },
        {
          type: 4,
          ticketId: data.ticketId,
          ticketUid: data.ticketUid,
          assigneeId: data.assigneeId
        }
      )
    })
  })

  emitter.on('ticket:note:added', function (ticket) {
    // Goes to client
    io.sockets.emit('updateNotes', ticket)
  })

  emitter.on('trudesk:profileImageUpdate', function (data) {
    io.sockets.emit('trudesk:profileImageUpdate', data)
  })

  emitter.on('$trudesk:flushRoles', function () {
    require('../permissions').register(function () {
      io.sockets.emit('$trudesk:flushRoles')
    })
  })
})()
