#!/usr/bin/env python3
"""Run against a built image: python3 scripts/docker-smoke.py IMAGE [PLATFORM]."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

image = sys.argv[1]
platform = sys.argv[2] if len(sys.argv) > 2 else None
name = 'clipboard-smoke-' + uuid.uuid4().hex[:10]
volume = name + '-data'
password = 'smoke-"quoted"-\\password'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def request(path, data=None, content_type='application/json', token=''):
    headers = {'Content-Type': content_type}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read()


def ready():
    for _ in range(60):
        try:
            return json.loads(request('/server'))
        except (OSError, ValueError):
            time.sleep(0.5)
    raise AssertionError('Container did not become ready')


try:
    docker('volume', 'create', volume)
    args = ['run', '-d', '--name', name, '-p', '127.0.0.1::9517',
            '-v', volume + ':/app/server-node/data',
            '-e', 'LISTEN_PORT=9517', '-e', 'PREFIX=/clipboard',
            '-e', 'MESSAGE_NUM=1000', '-e', 'TEXT_LIMIT=8192',
            '-e', 'FILE_EXPIRE=0', '-e', 'ROOM_LIST=true',
            '-e', 'AUTH_PASSWORD=' + password,
            '-e', 'ROOM_AUTH_JSON={"private":"room-secret"}']
    if platform:
        args += ['--platform', platform]
    docker(*args, image)
    info = json.loads(docker('inspect', name))[0]
    port = info['NetworkSettings']['Ports']['9517/tcp'][0]['HostPort']
    base = 'http://127.0.0.1:' + port + '/clipboard'
    server = ready()
    assert server['auth'] is True
    assert server['config']['server']['history'] == 1000
    config = json.loads(docker('exec', name, 'cat', '/app/server-node/config.json'))
    assert config['server']['auth'] == password
    assert config['server']['roomAuth'] == {'private': 'room-secret'}
    assert config['server']['historyFile'] == '/app/server-node/data/history.json'
    assert config['server']['storageDir'] == '/app/server-node/data/'
    assert config['text']['limit'] == 8192
    assert config['file']['expire'] == 0
    assert config['server']['roomList'] is True
    assert b'<html' in request('/')
    print('PASS: valid configuration, environment variables, subpath and embedded frontend')

    try:
        request('/content')
        raise AssertionError('Protected history was readable without authentication')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    token = json.loads(request('/auth/token', json.dumps({'password': password}).encode()))['token']
    body = b'Persistent Docker smoke message'
    text = json.loads(request('/text', body, 'text/plain', token))
    boundary = 'smoke' + uuid.uuid4().hex
    file_body = b'Persistent Docker smoke file\n'
    multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.txt"\r\n'
                 'Content-Type: text/plain\r\n\r\n').encode() + file_body + f'\r\n--{boundary}--\r\n'.encode()
    uploaded = json.loads(request('/upload', multipart, 'multipart/form-data; boundary=' + boundary, token))
    history = json.loads(request('/content', token=token))['messages']
    assert len(history) == 2
    assert any(str(item['id']) == str(text['id']) for item in history)
    file_info = next(item for item in history if str(item['id']) == str(uploaded['id']))
    file_path = '/file/' + file_info['uuid'] + '/smoke.txt'
    assert request(file_path, token=token) == file_body
    print('PASS: password protection, text send, file upload and download')

    # Wait for the async history save before recreating the container.
    for _ in range(40):
        try:
            stored = json.loads(docker('exec', name, 'cat', '/app/server-node/data/history.json'))
            if len(stored.get('receive', [])) == 2:
                break
        except (subprocess.CalledProcessError, ValueError):
            pass
        time.sleep(0.1)
    else:
        raise AssertionError('History was not persisted to the mounted volume')
    health_command = info['Config']['Healthcheck']['Test'][1]
    docker('exec', name, 'sh', '-c', health_command)
    docker('stop', '--time', '5', name)
    assert json.loads(docker('inspect', name))[0]['State']['ExitCode'] != 137
    docker('rm', name)
    # A fresh container uses the same volume, as compose up --force-recreate does.
    docker(*args, image)
    port = json.loads(docker('inspect', name))[0]['NetworkSettings']['Ports']['9517/tcp'][0]['HostPort']
    base = 'http://127.0.0.1:' + port + '/clipboard'
    ready()
    token = json.loads(request('/auth/token', json.dumps({'password': password}).encode()))['token']
    assert len(json.loads(request('/content', token=token))['messages']) == 2
    assert request(file_path, token=token) == file_body
    assert 'mkcert' in docker('exec', name, 'sh', '-c', 'command -v mkcert')
    print('PASS: healthcheck, stop signals and text/file persistence across container replacement')
except Exception:
    subprocess.run(['docker', 'logs', '--tail', '30', name], check=False)
    raise
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
