import { commandController, commandHandler, entityController, entityHandlers } from '@app/core';
import { Module } from '@nestjs/common';
import { CloseMeeting } from './close-meeting.command.js';
import { Meeting } from './meeting.entity.js';
import { RescheduleMeeting } from './reschedule-meeting.command.js';

@Module({
  controllers: [
    entityController(Meeting),
    commandController(CloseMeeting),
    commandController(RescheduleMeeting),
  ],
  providers: [
    ...entityHandlers(Meeting),
    commandHandler(CloseMeeting),
    commandHandler(RescheduleMeeting),
  ],
})
export class MeetingsModule {}
