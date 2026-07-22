pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Check Node.js') {
            steps {
                sh 'node --version'
                sh 'npm --version'
            }
        }

        stage('Install dependencies') {
            steps {
                dir('FE/bbiyong-react') {
                    sh 'npm ci'
                }
            }
        }

        stage('Build dashboard') {
            steps {
                dir('FE/bbiyong-react') {
                    sh 'npm run build'
                }
            }
        }

        stage('Archive build') {
            steps {
                archiveArtifacts artifacts: 'FE/bbiyong-react/dist/**', fingerprint: true
            }
        }

        stage('Deploy dashboard') {
            steps {
                dir('FE/bbiyong-react') {
                    sh 'docker compose up -d --build web'
                }
            }
        }
    }
}
