import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { CheckIn } from './check-in.command.js';
import { CloseMeeting } from './close-meeting.command.js';
import { Meeting } from './meeting.entity.js';
import { MeetingCheckIn } from './meeting-check-in.entity.js';
import { RescheduleMeeting } from './reschedule-meeting.command.js';

@Module({
  controllers: [
    entityController(Meeting),
    entityController(MeetingCheckIn),
    commandController(CloseMeeting),
    commandController(RescheduleMeeting),
    commandController(CheckIn),
  ],
  providers: [
    ...entityHandlers(Meeting),
    ...entityHandlers(MeetingCheckIn),
    commandHandler(CloseMeeting),
    commandHandler(RescheduleMeeting),
    commandHandler(CheckIn),
  ],
})
export class MeetingsModule {}
