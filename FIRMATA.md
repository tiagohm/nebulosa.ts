**main.cpp**

```cpp
#include <Arduino.h>
#include <ConfigurableFirmata.h>

#ifdef ESP8266
#define ENABLE_WIFI
#endif

// #define HIGH_OUTPUT_ON_POWERING_UP

#define ENABLE_DIGITAL
#define ENABLE_ANALOG
#define ENABLE_I2C

#ifdef ENABLE_DIGITAL
#include <DigitalInputFirmata.h>
DigitalInputFirmata digitalInput;

#include <DigitalOutputFirmata.h>
DigitalOutputFirmata digitalOutput;
#endif

#ifdef ENABLE_ANALOG
#include <AnalogInputFirmata.h>
AnalogInputFirmata analogInput;

#include <AnalogOutputFirmata.h>
AnalogOutputFirmata analogOutput;
#endif

#ifdef ENABLE_I2C
#include <Wire.h>
#include <I2CFirmata.h>
I2CFirmata i2c;
#endif

#ifdef ENABLE_SPI
#include <Wire.h>
#include <SpiFirmata.h>
SpiFirmata spi;
#endif

#ifdef ENABLE_ONE_WIRE
#include <OneWireFirmata.h>
OneWireFirmata oneWire;
#endif

#ifdef ENABLE_DHT
#include <DhtFirmata.h>
DhtFirmata dht;
#endif

#ifdef ENABLE_SERVO
#include <Servo.h>
#include <ServoFirmata.h>
ServoFirmata servo;
#endif

#ifdef ENABLE_FREQUENCY
#include <Frequency.h>
Frequency frequency;
#endif

#ifdef ENABLE_STEPPER
#include <AccelStepperFirmata.h>
AccelStepperFirmata accelStepper;
#endif

#include <FirmataExt.h>
FirmataExt firmataExt;

#include <FirmataReporting.h>
FirmataReporting reporting;

#ifdef ENABLE_WIFI
const char *WIFI_SSID = "ABCD";
const char *WIFI_PASSWORD = "12345678";
const int NETWORK_PORT = 27016;

#include <ESP8266WiFi.h>
#include "utility/WiFiClientStream.h"
#include "utility/WiFiServerStream.h"
WiFiServerStream serverStream(NETWORK_PORT);
#endif

void systemResetCallback()
{
#ifndef ESP32
    for (byte i = 0; i < TOTAL_PINS; i++)
    {
        if (IS_PIN_ANALOG(i))
        {
            Firmata.setPinMode(i, PIN_MODE_ANALOG);
        }
        else if (IS_PIN_DIGITAL(i))
        {
            Firmata.setPinMode(i, PIN_MODE_OUTPUT);
#ifdef HIGH_OUTPUT_ON_POWERING_UP
            digitalWrite(i, HIGH);
            Firmata.setPinState(i, HIGH);
#endif
        }
    }
#endif

    firmataExt.reset();
}

void initTransport()
{
#ifdef ESP8266
    // Need to ignore pins 1 and 3 when using an ESP8266 board. These are used for the serial communication.
    Firmata.setPinMode(1, PIN_MODE_IGNORE);
    Firmata.setPinMode(3, PIN_MODE_IGNORE);
#endif

#ifdef ENABLE_WIFI
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    pinMode(LED_BUILTIN, OUTPUT);

    bool pinIsOn = false;

    while (WiFi.status() != WL_CONNECTED)
    {
        delay(100);
        pinIsOn = !pinIsOn;
        digitalWrite(LED_BUILTIN, pinIsOn);
    }

    Firmata.begin(serverStream);
    Firmata.blinkVersion(); // Because the above doesn't do it.
#else
    Firmata.begin(115200);
#endif
}

void initFirmata()
{
#ifdef ENABLE_DIGITAL
    firmataExt.addFeature(digitalInput);
    firmataExt.addFeature(digitalOutput);
#endif

#ifdef ENABLE_ANALOG
    firmataExt.addFeature(analogInput);
    firmataExt.addFeature(analogOutput);
#endif

#ifdef ENABLE_I2C
    firmataExt.addFeature(i2c);
#endif

#ifdef ENABLE_ONE_WIRE
    firmataExt.addFeature(oneWire);
#endif

#ifdef ENABLE_DHT
    firmataExt.addFeature(dht);
#endif

#ifdef ENABLE_SERVO
    firmataExt.addFeature(servo);
#endif

#ifdef ENABLE_SPI
    firmataExt.addFeature(spi);
#endif

#ifdef ENABLE_FREQUENCY
    firmataExt.addFeature(frequency);
#endif

#ifdef ENABLE_STEPPER
    firmataExt.addFeature(accelStepper);
#endif

    firmataExt.addFeature(reporting);

    Firmata.attach(SYSTEM_RESET, systemResetCallback);
}

void setup()
{
    // Do this before initTransport(), because some client libraries expect that a reset sends this automatically.
    Firmata.setFirmwareNameAndVersion("Nebulosa", FIRMATA_FIRMWARE_MAJOR_VERSION, FIRMATA_FIRMWARE_MINOR_VERSION);
    initTransport();
    initFirmata();

    Firmata.parse(SYSTEM_RESET);
}

void loop()
{
    while (Firmata.available())
    {
        Firmata.processInput();

        if (!Firmata.isParsingMessage())
        {
            break;
        }
    }

    firmataExt.report(reporting.elapsed());

#ifdef ENABLE_WIFI
    serverStream.maintain();
#endif
}
```

**platformio.ini**

```ini
[platformio]
default_envs = nodemcu

[env:nodemcu]
platform = espressif8266
board = esp12e
framework = arduino
lib_deps = 
	https://github.com/tiagohm/ConfigurableFirmata.git
```
