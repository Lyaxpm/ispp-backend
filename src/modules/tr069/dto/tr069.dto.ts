import { IsArray, ArrayNotEmpty, IsString, IsUrl, MinLength } from 'class-validator';

export class SetWifiDto {
  @IsString()
  @MinLength(1, { message: 'SSID tidak boleh kosong.' })
  ssid!: string;

  @IsString()
  @MinLength(8, { message: 'Password WiFi minimal 8 karakter.' })
  password!: string;
}

export class SetPppoeDto {
  @IsString()
  @MinLength(1, { message: 'Username PPPoE tidak boleh kosong.' })
  username!: string;

  @IsString()
  @MinLength(1, { message: 'Password PPPoE tidak boleh kosong.' })
  password!: string;
}

export class FirmwarePushDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'deviceIds tidak boleh kosong.' })
  @IsString({ each: true })
  deviceIds!: string[];

  @IsUrl({}, { message: 'firmwareUrl harus URL valid.' })
  firmwareUrl!: string;
}
