pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Check Python') {
            steps {
                sh 'python3 --version'
            }
        }

        stage('Create test environment') {
            steps {
                dir('AI') {
                    sh '''
                        python3 -m venv .venv-ci
                        .venv-ci/bin/python -m pip install --upgrade pip
                        .venv-ci/bin/python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
                        .venv-ci/bin/python -m pip install -r requirements.txt
                    '''
                }
            }
        }

        stage('Run unit tests') {
            steps {
                dir('AI') {
                    sh '.venv-ci/bin/python -m unittest discover -s tests -v'
                }
            }
        }
    }
}
