# Modifications Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0


import logging
import sys
import importlib

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from volttron.platform.agent import utils
from volttron.platform.vip.agent import Agent, Core
from volttron.platform.scheduling import periodic
from volttron.platform.messaging.headers import TIMESTAMP
from volttron.platform.agent.utils import (get_aware_utc_now,
                                           format_timestamp)

utils.setup_logging()
_log = logging.getLogger(__name__)
__version__ = '1.0'

DEFAULT_HEARTBEAT_PERIOD = 300
OPENWEATHER_BASE_URL = 'https://api.openweathermap.org/data/3.0/onecall'


class WeatherAgent(Agent):
    """Periodically fetches weather data from OpenWeather 3.0 API
    and publishes outdoor temperature to a VOLTTRON topic.
    """

    def __init__(self, config_path, **kwargs):
        super().__init__(**kwargs)
        self.config = utils.load_config(config_path)
        self._heartbeat_period = self.config.get('heartbeat_period',
                                                 DEFAULT_HEARTBEAT_PERIOD)
        self.api_key = self.config.get('api_key', None)
        self.lat = self.config.get('lat', None)
        self.lon = self.config.get('lon', None)
        self.units = self.config.get('units', 'imperial')
        self.topic = self.config.get('topic', None)
        self.points = self.config.get('data_point', None)
        self.building_id = self.config.get('building', None)
        self.manager_id = self.config.get('manager', None)
        self.base_url = self.config.get('base_url', OPENWEATHER_BASE_URL)
        self.duplicate_enabled = self.config.get('duplicate_enabled', True)
        self._use_cached = False
        self._cached_weather_data = None

        if self.config['module'] is not None:
            try:
                control_class = "{}.{}".format(self.config['module'], self.config['class'])
                controller = importlib.import_module(control_class)
                self.initialize = controller.initialize
                self.preprocessing = getattr(controller, "preprocessing", None)
            except:
                _log.error('Invalid control module')
        try:
            self._heartbeat_period = int(self._heartbeat_period)
        except:
            _log.warning('Invalid heartbeat period specified setting to default')
            self._heartbeat_period = DEFAULT_HEARTBEAT_PERIOD

    @Core.receiver('onstart')
    def onstart(self, sender, **kwargs):
        if self.config['module'] is not None:
            control_class = "{}.{}".format(self.config['module'], self.config['class'])
            controller = importlib.import_module(control_class)
            self.initialize = controller.initialize
            self.preprocessing = getattr(controller, "preprocessing", None)
            self.initialize(OPENWEATHER_BASE_URL, self.manager_id)
        if self._heartbeat_period != 0:
            self.core.schedule(periodic(self._heartbeat_period), self.control_update)

    def control_update(self):
        headers = {TIMESTAMP: format_timestamp(get_aware_utc_now())}

        if self.duplicate_enabled and self._use_cached and self._cached_weather_data is not None:
            _log.info('Using cached weather data (duplicate cycle)')
            weather_data = self._cached_weather_data
            self._use_cached = False
        else:
            _log.info('Fetching weather data from OpenWeather 3.0 API')
            try:
                params = {
                    'lat': self.lat,
                    'lon': self.lon,
                    'appid': self.api_key,
                    'units': self.units,
                }
                response = requests.get(self.base_url, params=params, timeout=30, verify=False)
                response.raise_for_status()
                weather_data = response.json()
            except Exception as e:
                _log.error('Error fetching weather data: {}'.format(e))
                return
            if self.duplicate_enabled:
                self._cached_weather_data = weather_data
                self._use_cached = True

        # Extract current.temp and wrap in the standard payload format
        try:
            current_temp = weather_data['current']['temp']
        except KeyError as e:
            _log.error('Error parsing weather response: missing key {}'.format(e))
            return

        payload = {'output': {'outdoorTemperature': current_temp}}
        _log.info('Weather data received: outdoorTemperature={}'.format(current_temp))

        temp1, temp2 = self.preprocessing(payload, self.points, self.building_id)

        message = []
        message.append(temp1)
        message.append(temp2)
        try:
            self.vip.pubsub.publish(peer='pubsub',
                                    topic=self.topic,
                                    message=message,
                                    headers=headers).get(timeout=2)
        except Exception as exc:
            _log.error('Error publishing weather data: {}'.format(exc))


def main(argv=sys.argv):
    '''Main method called by the eggsecutable.'''
    try:
        utils.vip_main(WeatherAgent, version=__version__)
    except Exception as e:
        _log.exception('unhandled exception')


if __name__ == '__main__':
    # Entry point for script
    sys.exit(main())
