import { Module } from '@nestjs/common';
import { Tr069Controller } from './tr069.controller';
import { GenieAcsService } from './genieacs.service';

/**
 * Tr069Module: adapter GenieACS (TR-069) — remote WiFi/PPPoE config,
 * reboot, factory reset, optical stats, dan firmware push massal.
 * Konfigurasi via env: GENIEACS_URL, GENIEACS_USER, GENIEACS_PASS.
 */
@Module({
  controllers: [Tr069Controller],
  providers: [GenieAcsService],
  exports: [GenieAcsService],
})
export class Tr069Module {}
